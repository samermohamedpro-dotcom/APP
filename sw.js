// ═══════════════════════════════════════════════════════════════════
//  Service worker — ce qui permet à l'app de démarrer sans réseau.
//
//  Sans lui, les données étaient déjà en cache (persistentLocalCache dans
//  firebase.js) mais la PAGE ne se chargeait pas : coupure de réseau au
//  démarrage = écran blanc, alors que tout était là.
//
//  ── Ce fichier ne change JAMAIS d'une livraison à l'autre ──
//  Il ne contient aucune liste de fichiers à mettre en cache, donc aucun
//  numéro de version. Le dépôt reste ce qu'il a toujours été : app.css,
//  app.js, index.html. Ne redépose sw.js que si tu l'as modifié lui-même.
//
//  ── Réseau d'abord, cache en secours ──
//  Le contraire (cache d'abord) est plus rapide mais peut servir une
//  ancienne version après un dépôt. Sur un outil qui pilote le stock
//  d'une production quotidienne, corriger un bug doit rester instantané :
//  la fraîcheur passe avant les 200 ms gagnés.
// ═══════════════════════════════════════════════════════════════════

const CACHE_APP     = 'pg-app';
const CACHE_POLICES = 'pg-polices';

// Le strict minimum, sans numéro de version : la coquille qui permet
// d'afficher quelque chose hors ligne. app.js et app.css, eux, portent un
// ?v= et sont mis en cache au vol, à la première visite en ligne.
// Le nom de l'icône suit son dessin : `icone-*`, puis `icone-baleine-*`, puis
// `icone-monogramme-*` — sans quoi le cache du navigateur, celui du service
// worker et l'écran d'accueil continueraient de servir l'ancienne. Voir
// icones.py.
//
// ⚠️ `cache.addAll` est TOUT OU RIEN : un seul nom qui ne répond pas, et rien
// n'entre en coquille — ni la page, ni le manifeste. Le démarrage hors ligne
// tombe alors en silence, puisque l'échec est avalé plus bas. Ce nom doit donc
// être changé EN MÊME TEMPS que le fichier, jamais après.
const COQUILLE = ['./', './manifest.webmanifest', './icone-monogramme-180.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_APP);
      await cache.addAll(COQUILLE);
    } catch (e) {
      // Installation sans réseau : ce n'est pas une erreur. Le cache se
      // remplira à la première visite en ligne. Ne jamais faire échouer
      // l'installation pour ça — un service worker qui n'installe pas
      // laisse l'app sans secours hors ligne, en silence.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(
      noms.map((n) => (n === CACHE_APP || n === CACHE_POLICES ? null : caches.delete(n)))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Nos propres fichiers : réseau d'abord.
  if (url.origin === self.location.origin) {
    event.respondWith(reseauDabord(req, event));
    return;
  }

  // Les polices Google : elles ne changent jamais, cache d'abord.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(policeCacheDabord(req, event));
    return;
  }

  // TOUT LE RESTE PASSE SANS ÊTRE TOUCHÉ — en particulier Firestore et
  // l'authentification. Firestore tient une connexion longue pour le temps
  // réel ; la faire transiter par ici, même sans rien en faire, c'est
  // risquer de casser la synchronisation entre Doha et la France.
  // La liste ci-dessus est une autorisation, pas une interdiction : tout
  // ce qui n'y figure pas est ignoré. Ne jamais l'inverser.
});

async function reseauDabord(req, event) {
  try {
    const rep = await fetch(req);
    // status 200 strictement : une réponse partielle (206) fait échouer
    // cache.put, et une redirection n'a rien à faire en cache.
    if (rep && rep.status === 200 && rep.type === 'basic') {
      const copie = rep.clone();
      event.waitUntil((async () => {
        const cache = await caches.open(CACHE_APP);
        await purgerVersionsAnterieures(cache, req);
        await cache.put(req, copie);
      })().catch(() => {}));
    }
    return rep;
  } catch (err) {
    const cache = await caches.open(CACHE_APP);
    const enCache = await cache.match(req);
    if (enCache) return enCache;
    // Hors ligne sur une adresse jamais visitée : on sert la page d'accueil,
    // qui est une application d'une seule page — elle sait afficher la suite.
    if (req.mode === 'navigate') {
      const accueil = (await cache.match('./index.html')) || (await cache.match('./'));
      if (accueil) return accueil;
    }
    throw err;
  }
}

// app.js?v=202608272129 et app.js?v=202609010900 sont deux entrées distinctes
// pour le cache. Sans ce ménage, chaque livraison laisserait 1,5 Mo derrière
// elle. On efface donc les entrées qui ont le même chemin mais un autre ?v=.
async function purgerVersionsAnterieures(cache, req) {
  const chemin = new URL(req.url).pathname;
  if (!/\.(js|css)$/.test(chemin)) return;
  const cles = await cache.keys();
  await Promise.all(cles.map((cle) => {
    const u = new URL(cle.url);
    return (u.pathname === chemin && cle.url !== req.url) ? cache.delete(cle) : null;
  }));
}

async function policeCacheDabord(req, event) {
  const cache = await caches.open(CACHE_POLICES);
  const enCache = await cache.match(req);
  if (enCache) return enCache;
  const rep = await fetch(req);
  // Une feuille de style tierce revient « opaque » : illisible pour nous,
  // parfaitement utilisable par le navigateur. On la garde telle quelle.
  if (rep && (rep.status === 200 || rep.type === 'opaque')) {
    const copie = rep.clone();
    event.waitUntil(cache.put(req, copie).catch(() => {}));
  }
  return rep;
}

// Trappe de secours, déclenchée par index.html quand l'adresse contient
// ?sw=off. Si un jour le cache sert quelque chose d'aberrant, cette porte
// évite d'avoir à guider quelqu'un dans les réglages de Safari à distance.
self.addEventListener('message', (event) => {
  if (event.data !== 'purge') return;
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.map((n) => caches.delete(n)));
    await self.registration.unregister();
  })());
});
