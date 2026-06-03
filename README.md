# Lecture Syntopique — application (PWA)

Application web installable sur iPad pour pratiquer la **lecture syntopique** (méthode de Mortimer Adler) :
lire plusieurs PDF en parallèle, **censurer à l'Apple Pencil** les passages non essentiels (le doigt
sert uniquement à faire défiler), ne garder que les **~20 % utiles** (loi de Pareto), enregistrer ses
**connexions vocales**, et exporter un PDF filtré.

C'est une **PWA** : pas d'App Store, pas de Mac, pas de compte développeur, **100 % gratuit**, **hors-ligne** après la 1ʳᵉ ouverture.

---

## 1) Mettre l'app en ligne (une seule fois)

Il faut héberger le dossier sur une URL **HTTPS** (indispensable pour l'installation et le hors-ligne).
Deux options gratuites, de la plus simple à la plus classique :

### Option A — Netlify (la plus simple, sans rien installer)
1. Crée un compte gratuit sur **app.netlify.com** (pour garder une URL stable).
2. Va sur **app.netlify.com/drop**.
3. **Glisse-dépose tout le dossier** `App Syntopical Reading du 1er Juin 2026` dans la zone.
4. Netlify te donne une URL en `https://….netlify.app` → c'est ton app. (Tu peux renommer le site dans les réglages.)

### Option B — GitHub Pages
1. Crée un compte sur **github.com**, puis un dépôt (Repository) — il peut être public.
2. **Upload files** → glisse tout le contenu du dossier (garde le fichier `.nojekyll`).
3. Dépôt → **Settings → Pages** → Source = branche `main`, dossier `/root` → enregistre.
4. Au bout d'une minute, l'URL `https://ton-pseudo.github.io/ton-depot/` est active.

> ⚠️ **Garde toujours la même URL.** Les données de l'app (livres, censures, progression) sont liées à
> l'adresse du site. Si tu changes d'URL, utilise le bouton **Restaurer** avec ta sauvegarde.

---

## 2) Installer sur l'iPad 10

1. Ouvre l'URL dans **Safari** (pas un autre navigateur).
2. Bouton **Partager** → **« Sur l'écran d'accueil »**.
3. Lance l'app depuis l'icône : elle s'ouvre en plein écran, comme une vraie app.
4. La **1ʳᵉ ouverture doit être en ligne** (pour la mise en cache). Ensuite, ça marche **hors-ligne**.

---

## 3) Utilisation

- **Importer** : bouton « Importer un PDF » → choisis un ou plusieurs PDF (Fichiers, iCloud, Drive…).
  Ils sont copiés **dans l'app** (stockage privé local). Rien à ranger dans un dossier.
- **Lire** : touche « Ouvrir ». En haut s'affiche la **progression réelle** sous la forme
  **« X % lu · ~temps restant · pages restantes »** (barre fluide, en lecture simple **et** double).
  L'app **rouvre automatiquement à la dernière page lue**.
  Touche l'indicateur **p.X** (en haut à droite) pour **aller directement à une page** (en simple **et** en double).
- **Comparer (lecture double)** : « Comparer » sur un livre → choisis le second → les deux s'affichent côte à côte.
  Le bouton **⇄** en haut de chaque colonne permet de **remplacer** un des deux PDF par un autre sans quitter la
  comparaison. La **recherche 🔍** et l'**export** sont aussi disponibles en lecture double (ils agissent sur le
  panneau actif). Le défilement au doigt a une **inertie** ; le stylet dessine, même près du bord.
- **Censurer / surligner** (Apple Pencil ; le doigt fait défiler), dans la barre d'outils :
  - **Censurer (cacher)** : **▭ Rectangle** ou **◌ Forme libre (lasso)** — masque **noir**.
  - **Surligner (mettre en avant sans cacher)** : **🖊️ Surligneur** — trait **bleu translucide**, le texte reste lisible.
  - **⌫ Gomme** et **↶ Annuler**. **Effacer une censure précise** : prends la **⌫ gomme** et **tape la censure du doigt** (seule celle-là est retirée).
  - **« Censurer la page »** : masque **toute la page** en cours de lecture (elle sera **supprimée du PDF exporté**).
    En **lecture double**, il y a **un bouton par livre** (« Censurer G » / « Censurer D ») pour ne **pas** censurer les
    deux d'un coup. C'est **réversible** à tout moment : le bouton devient alors **« Rétablir la page »**.
- **Connexions vocales** (🎤) : enregistre à voix haute les liens que tu découvres entre les documents.
  Appuie sur **● Enregistrer**, parle, puis **■ Stop** : la note (audio **.m4a**) est rangée dans l'app, rattachée
  à la page (en lecture double, elle retient les **deux** livres/pages comparés). Pour chaque note : **▶︎ écouter**,
  **⤴ partager** (feuille de partage iOS → Google Drive, Fichiers, ou une IA comme Claude/Gemini), **🗑 supprimer**.
  Bouton **⤓ Tout exporter** pour partager toutes les notes d'un livre d'un coup. *(Le micro doit être autorisé
  dans Safari à la 1ʳᵉ utilisation. iOS enregistre en .m4a, lu partout — pas de mp3 natif.)*
- **Rechercher** (🔍, en lecture simple **et** double) : insensible à la **casse et aux accents** (« batons » trouve
  « Bâtons »…) et aux **ligatures** (« find » trouve « ﬁnd »). Filtre **Ce livre** / **Tous les livres** ; le mot
  trouvé est **surligné temporairement** dans la page. Si l'OCR d'un PDF scanné n'est pas fini, un message le signale.
- **OCR** : automatique à l'import pour les **PDF scannés** (anglais + français), pour rendre le texte cherchable.
- **Exporter** : se débloque **quand tu as réellement lu tout le livre** (le temps de présence sur chaque page
  est mesuré ; scroller jusqu'à la fin ne suffit pas). Le PDF exporté est une **expurgation gravée** :
  - les **pages censurées** (bouton « Censurer la page ») sont **définitivement supprimées** ;
  - les **zones raturées** (▭ rectangle / ◌ forme libre) sont **gravées** : le texte masqué **disparaît vraiment** ;
  - **tout le reste du texte demeure cherchable** (sélection, copie, lecture par une IA). Pour un PDF **scanné**,
    l'**OCR est ré-appliqué** à l'export pour conserver cette recherche — cela peut prendre quelques minutes.

  Ton livre d'origine reste **intact** dans l'app (seul un nouveau PDF est créé).
- **Sauvegarder / Restaurer** : exporte tout ton projet dans un fichier, et restaure-le (filet de sécurité,
  ou pour migrer vers une autre URL/un autre appareil).

---

## 4) Bon à savoir

- **Enregistrement automatique** : tes **censures, ta progression et tes notes vocales** sont sauvegardées sur
  l'appareil **au fur et à mesure** (instantanément, dans la base locale). Fermer l'app ou la **mettre à jour
  n'efface rien**. Le bouton **Sauvegarder** sert juste à créer une **copie de secours partageable** (filet de sécurité).
- **Sauvegarde régulière** : effacer les données de Safari peut vider l'app. Utilise **Sauvegarder** de temps en temps.
- L'app demande au système de **conserver** ses données (anti-effacement) ; ouvre-la au moins de temps en temps.
- **L'app affiche une ancienne version ?** Normalement les mises à jour s'appliquent seules quand tu ouvres l'app
  en ligne. Si une vieille version persiste : sur **PC (Chrome)** fais `Ctrl + Shift + R` (1-2 fois) ; sur **iPad**
  ferme complètement l'app et rouvre-la **connecté à Internet** (recommence si besoin). En dernier recours sur iPad :
  fais une **Sauvegarde**, retire l'icône de l'écran d'accueil et réinstalle depuis Safari (ne touche **pas** à
  « Effacer historique et données » de Safari, qui viderait l'app).
- Tout est **gratuit et hors-ligne** : aucune donnée n'est envoyée sur Internet.

---

## 5) Messages d'accueil, rappel quotidien & citation de sortie

- À **chaque ouverture**, l'app affiche une petite carte avec **deux rappels permanents** : (1) penser à
  **mémoriser les connexions** dans un *palais de mémoire* ; (2) enregistrer tes **connexions vocales**
  (bouton 🎤) puis les partager à une IA. *(Ces deux messages s'affichent toujours.)*
- Juste après s'affiche un **aide-mémoire** (lui aussi à chaque ouverture) : rappel express des gestes clés —
  **censurer**, **ouvrir 2 PDF côte à côte**, **censurer toute une page**, **rétablir une censure**
  (possible **même après avoir fermé puis rouvert** le PDF — tout est enregistré sur l'appareil).
- **Rappel quotidien 07h00 (3 mois)** : sur cette carte, le bouton **« ⏰ Activer le rappel quotidien »** ouvre
  **Google Agenda** avec un évènement récurrent prêt à enregistrer (un seul tap → « Enregistrer ») ; heure
  pré-réglée sur 07h00 (fuseau Europe/Paris, modifiable avant d'enregistrer).
  - Une fois activé, **le bloc disparaît** (l'app retient que tu as cliqué « Activer ») et **réapparaît**
    automatiquement avant la fin des ~3 mois pour que tu le recrées. Bouton **« Me le rappeler dans 3 mois »**
    pour le reporter. *(Une PWA ne peut pas lire ton Google Agenda : l'app sait seulement si tu as cliqué.)*
  - *Alternative hors-ligne* : le fichier `rappels/rappel-lecture-syntopique.ics` peut être ouvert sur l'iPad
    (ajout au calendrier) ou importé dans Google Agenda (Réglages → Importer).
- **Citation de sortie** : quand tu **quittes / mets l'app en arrière-plan**, un pop-up **plein écran** affiche
  une citation de motivation (Steve Jobs). Tu la vois en partant et elle t'attend à ton retour ; touche pour fermer.
- **Pause posture** : un rappel de **recadrage du dos** (debout, arrière de la tête + haut du dos + fesses contre
  un mur — « ange mural ») s'affiche **toutes les heures** passées dans l'app, et **juste après la citation** quand
  tu quittes. Objectif : contrer le dos voûté de la lecture prolongée.

## 6) Détails techniques (pour info)

- **Sans build** : HTML/CSS/JS en modules ES, bibliothèques **vendorisées** dans `vendor/` (aucun CDN).
  Pour mettre à jour l'app, modifie les fichiers, **incrémente `version.js`**, et re-déploie.
- Briques : **PDF.js** (rendu + texte), **pdf-lib** (export/suppression de pages), **Tesseract.js** (OCR eng+fra),
  **IndexedDB/OPFS** (stockage), **Service Worker** (`sw.js`) pour le hors-ligne.
- Tester en local sur PC : servir le dossier en HTTP (ex. `python -m http.server`) puis ouvrir `http://localhost:8000`
  (ne **pas** ouvrir le fichier `index.html` en `file://` : le hors-ligne/installation ne marcheraient pas).
