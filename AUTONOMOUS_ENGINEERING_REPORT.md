# Rapport de la session autonome — nuit du 5 octobre 2026

## État final

| | |
|---|---|
| **En ligne (gh-pages `e757435`, 5 oct. 14h15)** | app **v67** : synchronisation temps réel Firestore (projet `trombinoscope-90cf7`, créé par l'utilisateur) + 86/87 profils avec photo Instagram |
| **main** | `7874f72` (identique au code déployé) |
| **Vérifié en réel** | auth anonyme 620 ms, écriture 340 ms, lecture 130 ms, règles refusent tout accès hors espace ; site chargé sans erreur, SW v67 actif, porte mot de passe affichée |

Mise à jour : la section 3 ci-dessous (bascule) a été exécutée le matin même ; il ne reste que le secret du robot (optionnel).

---

## 1. Ce qui est en ligne maintenant : les photos de tout le monde

Sur les 87 profils, 78 avaient une photo, 8 n'en avaient pas et **At Alia avait les photos d'un autre compte**.

Trouvaille : la page `instagram.com/{handle}/embed/` (prévue pour l'intégration sur des sites tiers) est encore servie **sans compte** et contient `profile_pic_url`, à condition d'utiliser un User-Agent Safari (Firefox/Chrome-Android reçoivent une coquille vide). C'est une vignette 100×100 signée — modeste, mais c'est la seule voie publique encore ouverte en anonyme (Dumpor ne rend plus les profils, Jina bloque instagram.com, unavatar/Microlink ont des quotas journaliers par IP, l'API répond 401 sans session).

Le robot (`scripts/scan-ig-photos.mjs`) a reçu cette source, a été lancé depuis le Mac (IP résidentielle) sur une copie de `gh-pages` : **9/9 photos récupérées**, les 9 anciennes images d'At Alia (mauvais compte) retirées, données vérifiées (29 chunks, 135 images, 0 anomalie, 0 profil Instagram sans photo), publiées. Les appareils en v66 les reçoivent à leur prochain rafraîchissement (30 s / retour au premier plan).

Le robot GitHub Actions (cron toutes les 3 h) utilise désormais aussi l'embed, sans session. Si l'IP GitHub est bloquée par Instagram, il réessaie au passage suivant ; une session Instagram (secret `IG_SESSION`, que tu gères) donne en plus la photo HD.

---

## 2. La refonte temps réel (v67, prête)

### Pourquoi l'ancien système ne pouvait pas marcher
Chaque sauvegarde = **31 commits GitHub séquentiels** (manifest + 30 fichiers d'images) depuis le navigateur, avec un jeton d'écriture à dériver sur chaque appareil, et une lecture par sondage toutes les 30 s derrière un CDN (cache jusqu'à 10 min). Sur un téléphone avec une connexion moyenne, une coupure au 12ᵉ commit laissait les données à moitié envoyées. Aucune correction ne peut rendre ça instantané ni fiable.

### Nouvelle architecture
- **Firestore** (plan gratuit Spark, pas de carte bancaire) = source de vérité partagée, écoutée **en direct** (`onSnapshot`). Une modification sur un appareil apparaît sur les autres en moins d'une seconde.
- **IndexedDB** reste le miroir local que l'interface lit : l'app marche hors ligne, chaque modification est consignée dans un **journal persistant** (`rt_pending:{id}`) et repart automatiquement (retour du réseau, rechargement, relance). Testé : 3 modifications pendant une coupure réseau → toutes arrivées à la reconnexion.
- **Fusion champ par champ** (`js/merge.js`, 17 tests Node) : chaque champ porte l'horodatage de sa dernière modification. Deux personnes qui modifient deux champs du même profil en même temps gardent chacune leur modification — comme un document partagé. Le formulaire d'édition n'enregistre que les champs que l'utilisateur a changés depuis l'ouverture (une modification arrivée entre-temps sur un autre champ n'est pas écrasée — testé).
- **Suppressions douces** avec résurrection si le profil est modifié après coup (testé : supprimé sur A pendant que B le modifiait hors ligne → revit avec les modifications de B).
- **Photos versionnées** (`images/{profil::index::version}`) : une photo n'est téléchargée que si sa version change ; un appareil qui a déjà les mêmes photos (anciennes données) les **adopte sans rien ré-envoyer** (testé : 135 photos, 0 ré-envoi, signature serveur identique).
- **Mot de passe d'entrée** : il reste le seul accès. Il vérifie le coffre existant (inchangé) **et** dérive l'identifiant secret de l'espace partagé (`spaces/{id}/…`). Plus aucune clé d'écriture stockée ou renouvelée. Les appareils déjà déverrouillés en v66 rejoignent l'espace sans ressaisie.
- **Règles Firestore** (`firestore.rules`) : accès uniquement à l'intérieur d'un espace dont on connaît l'identifiant (64 hex dérivés du mot de passe), aucun listage possible.
- Migration = **aucun script** : le premier appareil qui se connecte envoie ses 87 profils + 135 photos (testé : 4 s sur l'émulateur), les suivants adoptent.

### Tests effectués (émulateur Firestore local + deux « appareils » = deux origines, bases locales séparées)
- Création / modification / suppression croisées, photos (envoi, réception, affichage).
- Modifications **simultanées** de champs différents → les deux survivent des deux côtés.
- Coupure réseau réelle (proxy TCP coupé) : 3 modifications en attente, libellé « En attente (3) », reprise immédiate à la reconnexion.
- Suppression concurrente + résurrection.
- Formulaire ouvert pendant une modification distante → seul le champ édité est enregistré.
- Migration des vraies données (87 profils, 135 photos, 12,9 Mo) depuis un appareil, réception sur le second (~1 s), puis adoption par un troisième sans ré-envoi.
- Deux onglets du même appareil : journal par profil + verrou `navigator.locks`.
- Robot photos en mode espace partagé : photo déposée → visible en direct sur l'autre appareil.
- Boot hors ligne avec serveur arrêté → l'app démarre sur le cache du Service Worker.

### Bugs trouvés et corrigés pendant les tests
- `reconcileAll()` tournait avant le premier instantané serveur → chaque profil local passait pour nouveau → 135 photos ré-envoyées en double (orphelines). Corrigé (attente du premier instantané + lecture serveur avant envoi d'un profil inconnu + versions posées après la transaction + nettoyage des documents photos non référencés, jamais avant 10 min).
- Reprise après coupure trop lente (backoff) → remise à zéro des réessais à la reconnexion.
- Journal en une seule clé écrasable entre onglets → un enregistrement par profil.

---

## 3. À faire au réveil pour mettre la v67 en ligne (≈ 10 min)

Les identifiants Firebase sont **publics** (ils figurent dans le code de toute app Firebase) ; la protection vient des règles + de l'identifiant d'espace dérivé du mot de passe. Tu peux donc me les coller dans le chat.

1. https://console.firebase.google.com → **Créer un projet** (nom libre, ex. `trombinoscope-fh`, Analytics inutile).
2. **Build → Firestore Database → Créer une base** : emplacement `eur3 (europe-west)`, mode **production**.
3. Onglet **Règles** : coller le contenu de `firestore.rules` → **Publier**.
4. **Build → Authentication → Commencer → Sign-in method → Anonyme → Activer**.
5. **Paramètres du projet (roue dentée) → Vos applications → `</>` Web** → nom libre → *Enregistrer* → copier l'objet `firebaseConfig` (apiKey, authDomain, projectId, …) et me le donner.

Ensuite je renseigne `js/firebase-config.js`, je déploie v67 (`main` → cherry-pick sur `gh-pages`), tu ouvres l'app sur le Mac (qui a toutes les données) : elle envoie tout ; le téléphone rejoint ensuite (son profil « coincé » part aussi).

Pour le robot photos dans le nouveau système : Réglages → **« Copier l'identifiant pour le robot »** → le coller dans le dépôt GitHub → *Settings → Secrets and variables → Actions* → secret **`TROMBI_SPACE_ID`**. Et ajouter dans `.github/workflows/scan-ig-photos.yml` (le jeton git local n'a pas le droit `workflow`, je n'ai pas pu le pousser) :

```yaml
      - name: Installer le SDK Firebase (espace partage)
        run: npm install --no-save --no-audit --no-fund firebase@12.19.0

      - name: Recuperer les photos Instagram manquantes
        env:
          TROMBI_SPACE_ID: ${{ secrets.TROMBI_SPACE_ID }}
        run: node scripts/scan-ig-photos.mjs
```

---

## 4. Commits (main)

- `0d5b63c` Refonte synchronisation : temps réel Firestore, fusion champ par champ (v67)
- `121983f` Sync : lecture serveur avant envoi, reprise immédiate après coupure, nettoyage des photos orphelines
- `990916b` Photo de profil Instagram automatique (photo seule), sources réellement vivantes
- `8f5bcb7` Robot photos : écrit dans l'espace partagé (Firestore) dès que l'app a basculé
- `fcc2b83` Robot : source « embed » Instagram (sans session) ; sync : journal par profil, verrou inter-onglets

gh-pages : `bddb63e` Robot IG : photos de profil de tous les profils (source embed, sans session).

## 5. Ce qui n'a pas pu être vérifié / reste ouvert

- **P1** — La v67 n'est testée que contre l'émulateur ; le vrai projet Firebase n'existe pas encore (étapes ci-dessus). Latence réelle et quotas Spark (50 000 lectures/jour, largement suffisant : ~90 lectures par ouverture d'app) à confirmer en conditions réelles.
- **P2** — Le robot GitHub Actions n'a pas été relancé depuis le cloud (l'IP datacenter peut être limitée par Instagram) ; le prochain passage planifié le dira. En attendant, les photos manquantes sont déjà en ligne.
- **P2** — Photos « embed » en 100×100 : suffisantes pour illustrer une fiche, un peu floues en grand. La session Instagram du robot (si elle est renseignée) donne la HD.
- **P3** — Les anciens fichiers `data/cloud/` restent sur gh-pages après la bascule (lecture seule ; à supprimer plus tard).
- Non fait : passes accessibilité / performance de rendu (non prioritaires devant la fiabilité).
