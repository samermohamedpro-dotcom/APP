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
//  ── Deux règles depuis le 04/09/2026, une par sorte de fichier ──
//
//  1. app.js?v=… et app.css?v=…, et les polices : CACHE D'ABORD. Une version
//     est une URL — le ?v= change à chaque livraison (règle 5) — donc un
//     fichier versionné ne change jamais de contenu : le relire au réseau
//     n'apprend rien et coûte, sur une 4G moyenne, la seconde qui sépare
//     « l'app s'ouvre » de « l'app rame ». Un ?v= jamais vu, lui, part au
//     réseau et entre en cache — et l'ancien ?v= est effacé.
//
//  2. index.html (et le reste) : RÉSEAU D'ABORD, mais pas plus de quelques
//     secondes. C'est la page qui porte le ?v= : la lire au réseau, c'est ce
//     qui fait qu'une correction arrive tout de suite sur le téléphone. Mais
//     un réseau qui met dix secondes à répondre, c'était dix secondes d'écran
//     blanc devant le four : passé le délai, la coquille en cache s'affiche,
//     et la réponse du réseau, quand elle arrive, remet le cache à jour pour
//     la prochaine ouverture.
//
//  Avant, tout était réseau d'abord sans délai : sur un réseau lent, l'app
//  attendait le réseau pour CHAQUE fichier — y compris ceux qui ne pouvaient
//  pas avoir changé.
// ═══════════════════════════════════════════════════════════════════

const CACHE_APP = 'pg-app';
// `pg-polices` a existé jusqu'au 03/09/2026, quand les polices venaient de
// Google. Elles sont chez nous depuis : le ménage de l'activation efface
// l'ancien cache, et il n'y a plus qu'une liste.

// Au-delà de ce délai, la page vient du cache si elle y est. Une 4G correcte
// répond en moins d'une seconde ; on ne pénalise que les réseaux qui, de
// toute façon, allaient faire attendre.
const DELAI_RESEAU_MS = 3500;

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
      noms.map((n) => (n === CACHE_APP ? null : caches.delete(n)))
    );
    await self.clients.claim();
  })());
});

// Un fichier versionné ne change jamais : app.js?v=… et app.css?v=…
function estVersionne(url) {
  return /\.(js|css)$/.test(url.pathname) && url.searchParams.has('v');
}

// Une police non plus : le fichier porte son nom, son poids et son alphabet,
// et un nouveau dessin serait un nouveau fichier (comme les icônes).
function estPolice(url) {
  return /\/polices\/[^/]+\.woff2$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Nos propres fichiers, et rien d'autre.
  if (url.origin === self.location.origin) {
    if (estVersionne(url) || estPolice(url)) {
      event.respondWith(cacheDabord(req, event));
    } else {
      event.respondWith(reseauDabord(req, event));
    }
    return;
  }

  // TOUT LE RESTE PASSE SANS ÊTRE TOUCHÉ — en particulier Firestore et
  // l'authentification. Firestore tient une connexion longue pour le temps
  // réel ; la faire transiter par ici, même sans rien en faire, c'est
  // risquer de casser la synchronisation entre Doha et la France.
  // La liste ci-dessus est une autorisation, pas une interdiction : tout
  // ce qui n'y figure pas est ignoré. Ne jamais l'inverser.
});

// Garde une copie en cache d'une bonne réponse — et rien d'autre.
// status 200 strictement : une réponse partielle (206) fait échouer
// cache.put, et une redirection n'a rien à faire en cache.
function mettreEnCache(cache, req, rep, event) {
  if (!rep || rep.status !== 200 || rep.type !== 'basic') return;
  const copie = rep.clone();
  const travail = (async () => {
    await purgerVersionsAnterieures(cache, req);
    await cache.put(req, copie);
  })().catch(() => {});
  // Quand la page a déjà été servie depuis le cache (réseau trop lent), la
  // réponse du réseau arrive APRÈS la fin de l'événement : `waitUntil` refuse
  // alors, et ce n'est pas grave — l'écriture est déjà lancée.
  try { event.waitUntil(travail); } catch (e) { /* événement déjà clos */ }
}

// Les fichiers versionnés : le cache répond s'il a ; sinon le réseau, et on garde.
async function cacheDabord(req, event) {
  const cache = await caches.open(CACHE_APP);
  const enCache = await cache.match(req);
  if (enCache) return enCache;
  const rep = await fetch(req);
  mettreEnCache(cache, req, rep, event);
  return rep;
}

// La page et le reste : le réseau répond s'il est là et pas trop lent ;
// sinon le cache ; et hors ligne sur une adresse jamais vue, la page
// d'accueil — c'est une application d'une seule page, elle sait afficher
// la suite.
async function reseauDabord(req, event) {
  const cache = await caches.open(CACHE_APP);
  const reseau = fetch(req).then((rep) => { mettreEnCache(cache, req, rep, event); return rep; });
  try {
    return await avecDelai(reseau, DELAI_RESEAU_MS);
  } catch (err) {
    const enCache = await cache.match(req);
    if (enCache) return enCache;
    if (req.mode === 'navigate') {
      const accueil = (await cache.match('./index.html')) || (await cache.match('./'));
      if (accueil) return accueil;
    }
    // Rien en cache : on rend la main au réseau, quel que soit son temps —
    // une réponse tardive vaut mieux qu'une erreur tout de suite.
    return reseau;
  }
}

// Une promesse qui abandonne après `ms`. Le réseau, lui, continue : sa
// réponse tardive servira quand même à remplir le cache (voir mettreEnCache).
function avecDelai(promesse, ms) {
  return new Promise((resoudre, rejeter) => {
    const minuterie = setTimeout(() => rejeter(new Error('délai réseau dépassé')), ms);
    promesse.then(
      (valeur) => { clearTimeout(minuterie); resoudre(valeur); },
      (erreur) => { clearTimeout(minuterie); rejeter(erreur); }
    );
  });
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
