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
- **Doc & version.** README + ce guide mis à jour ; correction « doigt ou Pencil » → **Apple Pencil uniquement** ;
  `version.js` → **2026.06.02.3**. App **publiée en ligne** sur GitHub Pages (cf. [[deploiement-en-ligne]] côté mémoire).
  Syntaxe ES vérifiée (`node --check`) + service HTTP local OK. Reste à valider sur iPad réel : micro `.m4a`,
  partage (Drive/Claude), et l'affichage de la citation de sortie.
