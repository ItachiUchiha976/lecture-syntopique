# Historique du projet — App de Lecture Syntopique

> Document de reprise : tout ce qu'on a décidé et construit ensemble, pour repartir sans perte de contexte.
> Dernière mise à jour : 2026-06.

---

## 1. Contexte & objectif

Créer une application installable sur **iPad 10 + Apple Pencil 1ʳᵉ génération** pour pratiquer la
**lecture syntopique** (méthode de Mortimer Adler) : lire plusieurs PDF en parallèle, **censurer** les
passages non essentiels, ne garder que les **~20 % utiles** (loi de Pareto), et exporter un PDF filtré.

Contrainte forte : l'utilisateur est sous **Windows 10, sans Mac**, et non-développeur. Tout doit être **gratuit**.

---

## 2. Décisions clés (et pourquoi)

| Décision | Choix retenu | Raison |
|---|---|---|
| **Type d'app / installation** | **PWA** (web app installée via Safari « Sur l'écran d'accueil ») | Seule voie 100 % gratuite, sans Mac ni compte Apple ; pas d'expiration (contrairement au sideload natif qui meurt tous les 7 jours) ; VM macOS = illégale/fragile. Recherche multi-sources à l'appui. |
| **Seuil « 80 % »** | Mesuré sur la **surface totale de la page**, via un **masque de pixels** | Simple, fiable, gère les chevauchements de formes sans double comptage. |
| **Export des pages conservées** | **Choix au moment de l'export** : graver (irréversible) ou garder intactes | Demandé par l'utilisateur. |
| **Censure réversible** | Oui, à tout moment (bouton « Rétablir ») | Une info jugée inutile au début peut devenir précieuse plus tard. |
| **Détection de lecture** | **Anti-triche** : temps de présence minimal par page (adaptatif selon le nb de mots), pas juste un scroll | Demandé : l'export ne se débloque que si le livre est réellement lu. |
| **OCR** | **Anglais + français**, automatique à l'import, seulement sur pages scannées | Les 2 langues comprises par l'utilisateur ; PDF numériques = texte instantané. |
| **Recherche** | Insensible **casse + accents** ; filtre **ce livre / tous les livres** ; résultats surlignés | Demandé (« batons » ↔ « Bâtons », « BATONS »…). |
| **Stockage** | **Sur l'appareil, hors-ligne** (IndexedDB + OPFS) | Privé, rapide, sans connexion. |
| **Outils de censure** | Rectangle, forme libre (lasso), surligneur de texte, gomme, annuler | **Apple Pencil uniquement** ; le doigt fait défiler (décision 2026-06-02). |
| **Notes vocales de connexion** | Enregistrer à voix haute les liens découverts ; audio **.m4a**, rattaché à la page ; partage iOS / inclus au backup | Demandé : l'utilisateur préfère parler (puis envoyer à une IA) plutôt qu'un canevas visuel (ajout 2026-06-02). |

---

## 3. Architecture technique

- **PWA sans build** : HTML/CSS/JS en modules ES natifs, bibliothèques **vendorisées** dans `vendor/`
  (aucun CDN → hors-ligne garanti). Service Worker `sw.js` versionné via `version.js`.
- **Bibliothèques** (toutes libres, épinglées) :
  - PDF.js `6.0.227` — rendu des pages + couche texte + rasterisation.
  - pdf-lib `1.17.1` — suppression de pages + dessin/gravure à l'export.
  - Tesseract.js `7.0.0` **+ tesseract.js-core `7.0.0`** — OCR eng+fra (le cœur doit matcher la 7.0.0 pour `relaxedsimd`).
  - idb `8.0.3` — accès IndexedDB.
- **Modules** (`js/`) : `main`, `router`, `storage`, `db-schema`, `pdf-engine`, `page-renderer`,
  `book-doc`, `text-normalize`, `word-counter`, `text-indexer`, `search`, `censor`, `stroke-smoothing`,
  `coverage`, `reading-tracker`, `export`, `backup`, `ocr`, `voice-recorder`, et l'UI dans `js/ui/`
  (`library-view`, `reader-view`, `reader-pane`, `dual-view`, `toolbar`, `search-view`, `export-flow`,
  `dialogs`, `voice-notes`, `welcome-tips`).
- **Contraintes iPad gérées** : plafond mémoire canvas (~384 Mo) → rendu adaptatif + virtualisation des
  pages + recyclage ; absence de `getCoalescedEvents` → lissage Bézier ; éviction 7 j → `navigator.storage.persist()`
  + sauvegarde manuelle ; pas de tâche de fond iOS → calculs au premier plan.

---

## 4. Construction par phases (toutes terminées ET testées en navigateur réel)

| Phase | Contenu | Résultat de test |
|---|---|---|
| 0 | Squelette PWA + vendoring + icônes/splash | app installable, offline |
| 1 | Import + persistance + bibliothèque | livre importé, stocké, vignette OK |
| 2 | Lecteur simple mémoire-safe | rendu réel, virtualisation (1 canvas vivant / 6 pages) |
| 3 | Couche texte + recherche | 23 spans, « batons » → 30 occ./6 pages, surlignage OK |
| 4 | Censure 3 outils + réversibilité | tracé persisté, overlay « page censurée » réversible |
| 5 | Vérification % (masque pixels) | rectangle 90×90 % → « 81 % » → dialogue → marquée |
| 6 | Détection de lecture anti-triche | temps cumulé par page, `bookRead=false` si pas lu |
| 7 | Export / redaction | export débloqué après lecture, 6→5 pages (1 censurée) |
| 8 | OCR (eng+fra) | scan → OCR auto → « BATONS » reconnu, cherchable |
| 9 | Lecture double côte à côte | 2 panneaux, focus, censure dans le bon livre |
| 10 | Sauvegarde / restauration | export JSON → stockage vierge → restauration complète |

**Régression finale : 5 suites de tests, 5 réussies, 0 échec, 0 erreur console.**

---

## 5. Comment reprendre plus tard (notes techniques)

- **Le code de l'app** est dans ce dossier ; rien à installer pour le faire tourner (PWA statique).
- **Tests automatisés** (hors dépôt) : `C:\Users\Fred\AppData\Local\Temp\synt-test\`
  (Playwright + pdf-lib). Serveur local : `…\synt-srv\server.py` sur `http://127.0.0.1:8765`.
  - Lancer : démarrer le serveur, puis `node test.cjs <pdf>`, `node test-export.cjs <pdf>`,
    `node test-ocr.cjs <pdf-scanné>`, `node test-dual.cjs <pdf>`, `node test-backup.cjs <pdf>`.
  - PDFs d'essai : `test-pdfs/sample.pdf` (texte), `test-pdfs/scanned.pdf` (image → OCR).
- **Vérifier la syntaxe** d'un module ES : le copier en `.mjs` puis `node --check fichier.mjs`.
- **Déployer** : héberger le dossier sur un statique HTTPS (Netlify Drop, ou GitHub Pages avec `.nojekyll`).
  À chaque mise à jour de code, **incrémenter `version.js`** pour forcer le rafraîchissement du cache.
- **Pistes d'amélioration possibles** (non faites, à discuter) : écran de réglages (vitesse de lecture,
  couleur de censure, seuil), cmaps PDF.js (pour polices CJK), scroll au doigt pendant le dessin au Pencil,
  recherche dans le mode double, miniatures de navigation.

---

## 6. État final

Application **fonctionnelle et complète**, conforme à toutes les demandes. Voir `README.md` pour
l'utilisation et `Guide d'installation.pdf` pour la mise en ligne et l'installation sur iPad.

---

## 7. Mises à jour (2026-06-02)

- **Censure réservée à l'Apple Pencil.** Le doigt ne sert plus qu'à **faire défiler** la page (plus aucun risque de
  censurer par erreur en naviguant). `censor.js` ignore `pointerType === 'touch'` ; la couche active passe en
  `touch-action: pan-x pan-y` (le doigt défile, le stylet est capturé et dessine ; la souris reste active pour les
  tests PC). *Caveat iOS Safari* : un tracé strictement vertical au stylet pourrait, en théorie, être pris pour un
  scroll (comportement standard type GoodNotes) — à confirmer sur l'iPad ; repli simple documenté si besoin.
- **Palm rejection.** La paume posée ne dessine pas (c'est un `touch`) et, pendant un tracé au stylet, le défilement
  est **verrouillé** (`onDrawingChange` côté censor → `scrollLock` dans reader-pane : `onScroll` rétablit la position) :
  la page ne bouge plus sous la main. Vérifié par `test-palm.cjs`.
- **Zoom utilisateur.** Boutons **− / 100% / +** (plage 50–300 %), en mode simple et double. En mode double, zoom
  **INDÉPENDANT par panneau** (agit sur le panneau focalisé : p.ex. 100 % à gauche / 110 % à droite ; le label %
  suit le focus). Conserve la position de lecture, défilement horizontal quand la page dépasse l'écran, rendu plus
  net borné (× zoom plafonné à 2×) pour la mémoire iPad. Censure indépendante du zoom (marques en unités PDF).
  Vérifié : `test-zoom.cjs` + `test-dual-zoom.cjs` PASS, non-régression (simple & double) OK, 0 erreur console.
- **Déploiement : GitHub Pages retenu** (compte déjà existant). Vérifié : app 100 % chemins relatifs + routeur en
  hash → fonctionne telle quelle sous `https://user.github.io/REPO/`, **sans modification de code**. Dépôt **public**
  = seul le code générique est publié ; PDF/censures/progression restent sur l'iPad. Garder `.nojekyll`, incrémenter
  `version.js` (passée à `2026.06.02.1`). **Mise en ligne via GitHub Desktop** (recommandé plutôt que le
  téléversement web — ~105 fichiers ; dépôt local hors Google Drive). Guide PDF mis à jour (GitHub Desktop = méthode A).

---

## 8. Mises à jour (2026-06-02 — notes vocales, accueil, rappel)

- **Notes vocales de connexion (🎤).** Nouveau module `voice-recorder.js` (getUserMedia + MediaRecorder, MIME
  **`audio/mp4`** prioritaire = `.m4a` AAC sur iPad ; repli WebM/Opus sur PC) et `ui/voice-notes.js` (bouton 🎤 +
  panneau : ● enregistrer / ■ stop + minuteur, liste des notes avec ▶︎ écouter / ⤴ partager / 🗑 supprimer, et
  ⤓ « Tout exporter »). **Choix produit** : format **M4A natif** (pas de mp3 : non natif iOS, plus lourd) ; note
  **rattachée à la page** (en lecture double, retient les 2 livres/pages dans `context`) ; partage **par note +
  tout exporter** via la feuille iOS (réutilise `backup.saveBlob` + nouveau `shareFiles`) ; **pas de transcription**.
- **Stockage.** DB passée en **v2** (`db-schema.js`) : nouveau store `voiceNotes` (`keyPath [bookId, noteId]`,
  index `byBook` / `byCreatedAt`). `storage.js` : `saveVoiceNote` / `getVoiceNotesByBook` / `getVoiceNote` /
  `deleteVoiceNote`, audio via `saveBinary` (clé `${bookId}/voice/${noteId}.m4a`), + `opfsRemoveFile` (suppression
  d'un seul fichier OPFS). Migration sûre : les livres v1 existants sont conservés.
- **Sauvegarde/restauration.** `backup.js` inclut désormais les notes (audio en base64), format **v2** ;
  `restoreBackup` accepte v1 **et** v2.
- **Lecture double — échange rapide (⇄).** Bouton sur chaque colonne (`dual-view.js`) pour remplacer un des 2 PDF
  sans quitter la comparaison (livre-ancre vs sources successives). Choix assumé : **rester à 2 panneaux** (confort
  iPad 10 + charge cognitive + Adler).
- **Messages d'accueil.** `ui/welcome-tips.js` (appelé depuis `main.js`) : **2 astuces permanentes** à chaque
  ouverture (palais de mémoire 🧠 + notes vocales 🎤). **Plus de case « Ne plus afficher »** (les astuces s'affichent
  toujours, demande du 2026-06-02).
- **Rappel quotidien 07h00 / 3 mois** (durée ramenée de 6 à 3 mois). Bouton sur la carte d'accueil → ouvre **Google
  Agenda** avec un évènement récurrent prérempli (1 tap « Enregistrer ») ; repli `rappels/rappel-lecture-syntopique.ics`
  (`RRULE:FREQ=DAILY;COUNT=92`). **Bloc conditionnel** : visible tant que `reminderDone` est faux ; le clic « Activer »
  pose `reminderDone`/`reminderDoneAt` → le bloc disparaît ; bouton **« Me le rappeler dans 3 mois »** (`reminderSnoozeUntil`) ;
  réapparition auto ~80 j après activation (avant l'expiration). Limite assumée : une PWA ne peut pas lire le Google
  Agenda → l'app sait seulement si l'utilisateur a cliqué « Activer ».
- **Citation de sortie.** `showExitQuote()` : pop-up **plein écran** (citation Steve Jobs) déclenché sur
  `visibilitychange → hidden` (≈ quand on quitte l'app sur iPad), une fois par session.
- **Correctif mise à jour / cache (`sw.js`).** L'ancienne stratégie « cache-first partout » pouvait **bloquer
  l'app sur une vieille version** (le code en cache re-enregistrait toujours l'ancien `sw.js?v=…`). Nouvelle stratégie :
  **network-first** pour les navigations + le code de l'app (`.js`/`.css`, dont `version.js`/`main.js`), **cache-first**
  pour `vendor/`/icônes/polices/WASM. Les mises à jour s'appliquent dès qu'on est en ligne, l'offline reste assuré.
  Comme le **contenu de `sw.js` change**, même un client bloqué récupère le correctif (le navigateur revérifie
  toujours le script du SW). `version.js` → **2026.06.02.4**.
- **Renfort iPad (`main.js`) + guide.** Ajout d'un `reg.update()` sur `visibilitychange → visible` : l'app vérifie
  une nouvelle version **à chaque retour au premier plan** (l'iPad adopte la mise à jour sans manip manuelle).
  Guide PDF + README enrichis : section **« L'app affiche une ancienne version ? »** (PC `Ctrl+Shift+R` / iPad
  fermer-rouvrir en ligne / dernier recours réinstaller après Sauvegarde) + réassurance **« données enregistrées
  automatiquement »** (censures via `reader-pane.js` `onCommit → store.patchPage`, instantané ; les MAJ ne touchent
  jamais IndexedDB/OPFS). `version.js` → **2026.06.02.5**.
- **Aide-mémoire d'utilisation (`showUsageGuide`).** 2ᵉ carte affichée à chaque ouverture, juste après les 2 messages
  (enchaînée depuis le `close` de `showWelcomeTips`) : gestes clés (censurer / ouvrir 2 PDF / censurer toute une page /
  rétablir). `version.js` → **2026.06.02.6**.
- **Clarification produit (réversibilité).** Les censures sont enregistrées en continu mais **toujours réversibles** ;
  rien n'est définitif tant qu'on ne fait pas un **export « graver »** (qui ne produit qu'une copie filtrée — l'original
  reste intact dans l'app). Le temps de lecture **déverrouille l'export**, il ne fige pas les censures.
- **Pause posture (`showPostureReminder`).** Rappel de recadrage du dos contre un mur (« ange mural » / wall angel) :
  déclenché **toutes les heures de présence active** (compteur de temps au 1er plan dans `main.js`, tick 60 s) **et à
  la sortie**, enchaîné juste après la citation (depuis le `close` de `showExitQuote`). `version.js` → **2026.06.02.7**.
- **Aide-mémoire précisé.** L'item « Rétablir une censure » indique désormais que c'est possible **même après
  fermeture/réouverture du PDF** (les `censorMarks` + l'état `censored` sont rechargés depuis IndexedDB par
  `reader-pane.js`). `version.js` → **2026.06.02.8**.
- **Correctif censure au stylet sur iPad (CRITIQUE).** La couche de censure active était en `touch-action: pan-x pan-y`
  → sur un vrai iPad, Safari interprétait le tracé de l'Apple Pencil comme un **défilement** (le stylet « réagissait
  comme un doigt », aucune censure ne s'affichait). Passée en **`touch-action: none`** (`reader.css`) → le stylet
  dessine. Conséquence : le **défilement au doigt** est désormais géré manuellement dans `censor.js` (pointeur
  `touch` → drag-scroll du `.pages-scroller`, jamais de dessin ; palm rejection conservée pendant un tracé stylet).
- **Correctif suppression de livre.** La purge des notes vocales ajoutée dans `deleteBook` pouvait lever une exception
  (selon l'état de la base) et **bloquer toute la suppression**. Sécurisée (`objectStoreNames.contains` + try/catch),
  et `library-view` affiche maintenant une vraie erreur si la suppression échoue. `version.js` → **2026.06.02.9**.

## 9. Mises à jour (2026-06-03 — lot de corrections UX/recherche)

- **Coordonnées du pointeur (censure côté droit + surligneur).** `censor.js` utilisait `e.offsetX/offsetY`, peu
  fiables sur Safari quand le pointeur est **capturé** (deviennent relatifs à l'écran → décalage à droite d'une page
  centrée, et hit-test du surligneur cassé). Remplacé par **`getBoundingClientRect()` + clientX/Y** → la censure et le
  surligneur fonctionnent sur toute la page.
- **Effacer une censure au doigt.** En mode gomme **⌫**, un **tap du doigt** sur une censure l'efface (juste celle-là,
  via `eraseAt`) ; un glissé du doigt fait défiler. Distinction tap/glissé par seuil de mouvement (`panMoved`).
- **Recherche : mots anglais manquants.** `text-normalize.js` passe de **NFD → NFKD** : décompose les **ligatures**
  typographiques (`ﬁ→fi`, `ﬂ→fl`, `ﬀ→ff`…) très fréquentes en anglais → « find » trouve « ﬁnd », etc. `text-indexer.js`
  joint les items avec une **espace** (meilleure séparation des mots). **`INDEX_VERSION = 2`** → ré-indexation
  automatique des livres existants, en **préservant le texte OCR** déjà calculé (pas de ré-OCR).
- **Surlignage de recherche temporaire.** `reader-pane.js` : le résultat cliqué est surligné (pulse ambre) et
  **s'efface tout seul après ~6 s** ; défilement automatique vers le mot.
- **Aller à une page.** Indicateur **p.X** tactile dans l'en-tête du lecteur (`reader-view.js`) → saisie d'un numéro
  → saut direct (fini le scroll interminable vers la page 153).
- **Suppression de livre découvrable.** Bouton **🗑** bien visible dans le coin de chaque vignette (`library-view.js`
  + `app.css`), en plus du bouton « Suppr. ».
- `version.js` → **2026.06.03.1**.

## 10. Améliorations confort (2026-06-03)

- **Reprendre à la dernière page lue.** À l'ouverture d'un livre (hors arrivée par la recherche), on défile à
  `readingProgress.lastPageIndex` (`reader-view.js` ; en double, chaque panneau via `getProgress`). Le suivi de
  lecture stockait déjà cette info.
- **Saut de page en lecture double.** Indicateur **p.X** tactile dans l'en-tête du mode double (`dual-view.js`),
  agissant sur le **panneau focalisé** ; le libellé suit le focus et la page active.
- **Surligneur = marqueur robuste.** L'outil 🖊 ne dépend plus de la couche texte (fragile, nulle sur PDF scannés) :
  il trace désormais une **bande épaisse** le long du tracé au stylet (nouveau type de masque **`marker`**
  = `{ path[], width }`). Géré partout : `censor.js` (tracé + aperçu + effacement par proximité), `coverage.js`
  (compte au masque de pixels), `export.js` (gravure raster **et** mode léger via `drawLine` à bouts ronds).
  L'ancien type `highlight` (quads) reste lu pour compatibilité. `version.js` → **2026.06.03.2**.
- **Aide-mémoire & README enrichis.** Les 3 nouveautés (reprise de lecture, saut de page simple+double, surligneur
  marqueur, effacer au doigt) sont documentées dans la carte d'aide-mémoire à l'ouverture (`welcome-tips.js`) et le
  README. `version.js` → **2026.06.03.3**.

## 11. Lot de corrections (2026-06-03, soir)

- **Notes vocales injouables (#5).** Les fichiers OPFS étaient relus en `Blob` **sans type MIME** → `<audio>` iOS
  refusait. `voice-notes.js` : on recrée le Blob avec `n.mime` (`audio/mp4`) + `audio.play()` explicite + contrôles.
- **Surligneur bleu translucide (#4).** Le `marker` n'est plus noir-censure : couleur **bleue ~0.32** (texte visible),
  **exclu du calcul de couverture** (`coverage.js`) — c'est une emphase, pas une censure — et rendu **bleu translucide
  à l'export** (raster + `drawLine` `opacity`). `censor.js` `strokePath(color)`, `toolbar`/aide-mémoire mis à jour.
- **Seuil 80 % automatique (#1).** `reader-view.js` + `dual-view.js` : sur `onMarksChange` (débounce 700 ms), si la
  couverture dépasse le seuil → **proposition auto** de censurer toute la page (≥99,5 % = auto) ; 1×/page (`autoPrompted`).
- **Dézoom élargi (#2).** `MIN_ZOOM` 0.5 → **0.35** (voir la page entière).
- **Côté droit du panneau droit en double (#3).** Coordonnées déjà robustes (`getBoundingClientRect`) ; ajout d'une
  **marge latérale** en mode double (`reader.css`) pour éloigner le contenu des bords d'écran (gestes iOS). À confirmer
  sur iPad — signalé pour l'analyse externe.
- `version.js` → **2026.06.03.4**.

## 12. Correctifs issus des analyses externes (3 IA) — 2026-06-03

- **A1 — Course multi-touch stylet/doigt (`censor.js`, réécrit).** On route le tracé/scroll par `pointerId`
  (`penId`/`panId`) : le stylet a toujours la priorité, une paume posée avant ne détourne plus le tracé et ne
  laisse plus de censure parasite au lever ; pendant un tracé stylet, tout doigt est ignoré. **+ inertie**
  (momentum lissé, friction, arrêt aux butées) pour le défilement au doigt (qui était « sec » sans le momentum
  natif quand un outil est actif). **+ DPR 1** sur la couche (÷4 mémoire). Code mort retiré ; `isDrawing()` exposé.
- **A2 — Bord droit non censurable (`reader.css`).** iOS réserve ~20 px le long des bords physiques (gestes
  système). Marges **≥ 24 px** sur les bords qui touchent l'écran (paysage : extérieur des colonnes ; portrait :
  les deux ; lecture simple : 16 px latéraux), via `env(safe-area-inset-*)`.
- **A3 — Surlignage de recherche multi-mots (`reader-pane.js`).** `applyHighlight` joignait les items SANS espace
  alors que l'index les joint AVEC espace → les expressions ne se surlignaient pas. Aligné sur le même séparateur.
- **A4 — `loadBinaryBlob` porte le MIME (`storage.js`).** Évite les Blob OPFS sans type (injouables en `<audio>` iOS).
- **E1 — XSS via titre PDF (`library-view.js`).** `escapeHtml(b.title)` dans le message de suppression (rendu en `innerHTML`).
- **Perf (`ocr.js`).** Worker Tesseract **libéré** (`terminate`) quand plus aucun OCR en cours (langues = plusieurs Mo).
- **Course OCR/suppression (`ocr.js`, `text-indexer.js`).** Garde `if (!await getBook(id)) break/return` dans les
  boucles → plus de **pages fantômes** si on supprime un livre pendant son indexation/OCR.
- **Service Worker (`main.js`).** Rechargement **uniquement pour une vraie mise à jour** (`updatePending`, plus de
  reload parasite au 1er chargement dû à `clients.claim`) **et uniquement quand l'app est en arrière-plan** (ne coupe
  plus une censure / un enregistrement).
- **Restauration robuste (`backup.js`).** Chaque livre isolé en `try/catch` (un échec n'interrompt plus tout) ;
  retourne le nb réellement restauré. **+ avertissement** avant une grosse sauvegarde (> 150 Mo).
- **Lecture double enrichie (`dual-view.js`, `search-view.js`).** Ajout de la **recherche** (livre focalisé, va au
  bon panneau ; `search-view` accepte un livre courant modifiable) **et de l'export** (bouton « Exporter » du livre
  focalisé, débloqué quand ce livre est lu). Fuite corrigée : `voice`/`search` détruits proprement.
- *Reporté (volontaire) :* CSP (risque de casser WASM/worker hors-ligne — la faille E1 est déjà corrigée),
  allocation paresseuse des canvas, index de recherche inversé, busy()/SW affiné.
- `version.js` → **2026.06.03.5**.

## 13. Confort quotidien (points reportés les plus utiles) — 2026-06-03

- **Indicateur OCR dans la recherche (`search-view.js`).** Quand l'indexation/OCR du/des livre(s) concerné(s) tourne
  encore, une note s'affiche sous la barre : « 🔄 Indexation/OCR en cours — certains résultats peuvent encore manquer ».
  Fini le « Aucun résultat » trompeur sur un scanné fraîchement importé.
- **« Pages restantes » pour l'export (`reader-view.js`).** Le bouton Exporter désactivé indique désormais le nombre
  approximatif de pages encore à lire (au lieu d'un simple « termine la lecture »).
- **Conseil stylet (`toolbar.js`).** À la 1ʳᵉ sélection d'un outil de censure (par session), un toast rappelle :
  « Dessine avec l'Apple Pencil ; le doigt fait défiler ; gomme = tape une censure du doigt ».
- *Toujours reporté (faible bénéfice / risque) :* CSP, allocation paresseuse des canvas, index inversé.
- `version.js` → **2026.06.03.6**.

## 14. Comparaison avec une 4ᵉ implémentation externe — 2026-06-03

Comparé notre app à une version « entièrement corrigée » par une 4ᵉ IA (dossier `Quatrième analyse/`). Sa base
= notre dump v.4 + les correctifs des analyses (A1/A2/A3/E1, course OCR, SW, Tesseract) — donc un **sous-ensemble**
de notre app actuelle (il lui manque DPR÷4, recherche+export en double, indicateur OCR, pages restantes, conseil
stylet, avertissement grosse sauvegarde, restauration par-livre). **Un seul point repris** car réellement meilleur :
sa garde anti pages-fantômes utilise un **`Set` synchrone `cancelledBooks`** (posé par `deleteBook`, lu dans les
boucles OCR/indexation) — plus propre que mon `await getBook()` (pas de relecture base par page, pas de fenêtre de
course). Adopté dans `storage.js` / `ocr.js` / `text-indexer.js`. Son garde-fou SW via `busy()`/`__setBusy` a été
**considéré mais non repris** : notre approche (reload seulement sur vraie MAJ ET en arrière-plan) évite aussi la
perte de données ET tout rechargement-surprise en pleine lecture. `version.js` → **2026.06.03.7**.

## 15. Doc & aide-mémoire à jour — 2026-06-03

- **README + Guide PDF régénérés** pour refléter l'app actuelle (surligneur bleu d'emphase, gomme au doigt,
  recherche + export en lecture double, reprise dernière page, saut de page, indicateur OCR, pause posture).
- **Aide-mémoire d'accueil (`welcome-tips.js`)** : rubrique **« Les outils de la barre »** ajoutée (chaque outil
  expliqué : ✋ ▭ ◌ 🖊️ ⌫ ↶ zoom, Vérifier, 🎤 🔍 p.X ⇄ Exporter), contenu actualisé, et la carte est désormais
  **défilante** (`.usage-scroll`, `max-height: 86vh`) — en-tête et bouton « Compris » restent visibles.
- `version.js` → **2026.06.03.8**.
- **Doc & version.** README + ce guide mis à jour ; correction « doigt ou Pencil » → **Apple Pencil uniquement** ;
  `version.js` → **2026.06.02.3**. App **publiée en ligne** sur GitHub Pages (cf. [[deploiement-en-ligne]] côté mémoire).
  Syntaxe ES vérifiée (`node --check`) + service HTTP local OK. Reste à valider sur iPad réel : micro `.m4a`,
  partage (Drive/Claude), et l'affichage de la citation de sortie.

---

## 16. Lot de corrections (2026-06-03, nuit) — censure explicite, export cherchable, mise en page double

Demandes de l'utilisateur après usage réel sur iPad. `version.js` → **2026.06.03.9**.

- **Bug — bord droit non censurable en lecture double.** Cause confirmée (diagnostic multi-agents) :
  `computeBaseW` (reader-pane.js) soustrayait un **`-24` codé en dur** au lieu du **padding réel**. En paysage, le
  panneau droit a 40 px de padding (16+24) ; on n'en retirait que 24 → la page **débordait de 16 px** et son bord
  droit tombait à ~8 px du bord physique, **dans la zone de gestes système iPad** (~20 px) qui avale le 1ᵉʳ contact du
  Pencil. **Fix** : lecture du padding via `getComputedStyle` ; gouttière anti-gestes portée à **28 px** (`reader.css`).
- **Bug — décalage du tracé en double.** La chaîne de coordonnées (`localPt = clientX − getBoundingClientRect().left`)
  est **mathématiquement correcte** (immune au scroll/padding/flex) — vérifié de façon adverse. Le fix du débordement
  ci-dessus supprime le scroll horizontal parasite (contributeur le plus plausible). Si un décalage subsiste, cause
  probable = **pinch-zoom du visual viewport iPad** (`user-scalable=no` ignoré par Safari iOS), à confirmer sur l'appareil.
- **Censure repensée.** Suppression de la **détection auto à 80 %** (peu fiable) et du bouton **« Vérifier »**.
  Remplacés par un bouton explicite **« Censurer la page / Rétablir la page »** sur la page active. En **double**,
  **un bouton par panneau** (« Censurer G / D ») → ne censure jamais les deux livres d'un coup. Réversible.
- **Export refondu — un seul mode = REDACTION GRAVÉE, mais texte cherchable conservé.** Le mode « léger » est retiré.
  Pages censurées **supprimées** ; ratures (rectangle/forme libre) **gravées** (texte dessous vraiment détruit) ; le reste
  du **texte reste cherchable** via une couche invisible (`opacity:0`) : **texte natif** (numérique, items sous masque
  exclus), **ré-OCR** de l'image raturée (scanné raturé), texte OCR **stocké** injecté (scanné non raturé). Seules les
  pages raturées sont rasterisées ; les autres **copiées intactes** (copie groupée, pas de gonflage).
- **Barre de progression affinée.** Désormais **fractionnaire** (plus de palier par page) + libellé
  **« X % lu · ~Y min · Z p. restantes »** ; ajoutée aussi en **lecture double** (suit le panneau actif).
- **Aide-mémoire** (`welcome-tips.js`) mis à jour (plus de « Vérifier » ni de « 80 % »).
- **Validation.** `node --check` sur tous les fichiers ; **tests d'intégration en Chrome headless via CDP** sur
  `sample.pdf` (numérique) + `scanned.pdf` (scanné) : suppression de page, rasterisation+masque, **texte réinjecté
  extractible** (natif + OCR injecté + **ré-OCR** = 17 mots positionnés), tous **PASS**. Reste à confirmer sur iPad réel
  le décalage du tracé (bug visual-viewport éventuel) et le confort du bord droit.
