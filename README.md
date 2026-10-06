# Prépa TSI · Cours

Application web auto-hébergée d'organisation de cours, inspirée de Google Drive et pensée pour
les **PDF** : navigation par dossiers, lecteur PDF intégré, téléchargement direct, upload par
glisser-déposer, le tout administrable par un ou plusieurs comptes administrateurs.

- Arborescence créée automatiquement au premier démarrage : `TSI1` / `TSI2` → `Anglais`,
  `Français`, `Maths`, `Physique-Chimie`, `SII` → `Colles`, `Cours`, `Exercices`.
- Fil d'Ariane, vue grille (avec miniature de la 1ʳᵉ page des PDF) ou liste, recherche
  instantanée insensible aux accents (`/` pour y accéder).
- Lecteur PDF.js intégré (servi en local, sans CDN) : rendu paresseux des pages, zoom, saut de page,
  ouverture dans un nouvel onglet, téléchargement.
- Upload multiple par bouton ou glisser-déposer, avec progression ; création, renommage et
  suppression (récursive) de dossiers et d'années.
- Consultation **publique ou privée** (`PUBLIC_READ`) ; toute modification est réservée aux **admins**.
- Interface responsive (mobile → desktop), thème clair/sombre automatique.

---

## 1. Architecture

```
┌──────────────┐   HTTPS   ┌─────────────────────┐  HTTP   ┌──────────────────────────────────┐
│  Navigateur  │──────────▶│ Reverse-proxy       │────────▶│ Node.js 22 + Express 5 (:3000)   │
│  SPA JS      │           │ Nginx / Traefik /   │         │  ├─ /api/auth     sessions, CSRF  │
│  + PDF.js    │◀──────────│ Cloudflare Tunnel   │◀────────│  ├─ /api/folders  arborescence    │
└──────────────┘           └─────────────────────┘         │  ├─ /api/files    upload/lecture  │
                                                            │  └─ /  /vendor    statiques      │
                                                            └───────────────┬──────────────────┘
                                                                            │
                                                  ┌─────────────────────────┴───────────────┐
                                                  │ Volume /data                             │
                                                  │  ├─ app.db     SQLite (WAL) : users,     │
                                                  │  │             sessions, folders, files  │
                                                  │  ├─ files/<uuid>  contenu des fichiers   │
                                                  │  └─ tmp/        uploads en cours         │
                                                  └──────────────────────────────────────────┘
```

| Couche      | Choix                                                                                   |
|-------------|-----------------------------------------------------------------------------------------|
| Backend     | Node.js 22, Express 5, `better-sqlite3`, `argon2`, `multer`, `helmet`, `express-rate-limit` |
| Frontend    | SPA en JavaScript natif (modules ES), CSS fait main avec tokens de design. Aucune étape de build, aucun CDN |
| Lecteur PDF | `pdfjs-dist` (build *legacy* pour la compatibilité navigateurs), servi par l'application |
| Stockage    | Fichiers sur disque local, **nommés par UUID** ; arborescence et métadonnées en SQLite  |
| Déploiement | Docker multi-stage (utilisateur non-root, FS en lecture seule), Compose, reverse-proxy HTTPS |

### Arborescence du projet

```
├── src/
│   ├── server.js          point d'entrée : config, seed, démarrage, ménage périodique
│   ├── app.js             application Express (en-têtes de sécurité, routes, erreurs)
│   ├── config.js          lecture des variables d'environnement
│   ├── db.js              schéma SQLite
│   ├── seed.js            arborescence par défaut + compte admin initial
│   ├── security.js        Argon2id, sessions, CSRF, contrôles d'accès
│   ├── storage.js         validation des noms, types MIME, signatures, stockage UUID
│   └── routes/            auth.js · folders.js (dont recherche) · files.js
├── public/                index.html + assets/ (app.js, lib.js, viewer.js, thumbs.js, app.css)
├── scripts/users.js       gestion des comptes en ligne de commande
├── test/app.test.js       tests (node:test + supertest)
├── deploy/                nginx/ · traefik/ · cloudflared/
├── Dockerfile · docker-compose.yml · .env.example
```

### API

| Méthode | Route                          | Accès   | Rôle                                                |
|---------|--------------------------------|---------|-----------------------------------------------------|
| GET     | `/api/auth/me`                 | tous    | utilisateur courant + jeton CSRF                    |
| POST    | `/api/auth/login` · `/logout`  | tous    | connexion (limitée en débit) / déconnexion          |
| POST    | `/api/auth/password`           | connecté| changement de mot de passe (révoque les autres sessions) |
| GET     | `/api/folders/root` · `/:id`   | lecture | contenu d'un dossier + fil d'Ariane                 |
| POST    | `/api/folders`                 | admin   | créer un dossier (`parentId: null` = nouvelle année)|
| PATCH · DELETE | `/api/folders/:id`      | admin   | renommer / supprimer récursivement                  |
| POST    | `/api/folders/:id/files`       | admin   | upload multipart (champ `files`)                    |
| GET     | `/api/files/:id`               | lecture | métadonnées                                         |
| GET     | `/api/files/:id/view` · `/download` | lecture | affichage inline (PDF/images) / téléchargement |
| PATCH · DELETE | `/api/files/:id`        | admin   | renommer / supprimer                                |
| GET     | `/api/search?q=`               | lecture | recherche par nom                                   |

« lecture » = public si `PUBLIC_READ=true`, sinon utilisateur connecté.

---

## 2. Sécurité

**Authentification**
- Mots de passe hachés en **Argon2id** (m = 19 Mio, t = 2, recommandations OWASP). Le temps de
  réponse est le même que l'utilisateur existe ou non.
- Sessions **opaques** : jeton aléatoire de 256 bits dans un cookie `__Host-sid`
  `HttpOnly; Secure; SameSite=Strict`. Seul son hash SHA-256 est stocké en base, ce qui permet la
  révocation côté serveur (déconnexion, changement de mot de passe). Le jeton est régénéré à chaque
  connexion, ce qui empêche la fixation de session.
- Limitation des tentatives de connexion (10 échecs / 15 min / IP par défaut).
- Rôles `admin` (tout) et `viewer` (lecture seule, utile en mode privé).

**CSRF** (défense en profondeur sur toute requête modifiante)
1. cookie `SameSite=Strict` ;
2. rejet de `Sec-Fetch-Site: cross-site` et d'un en-tête `Origin` différent de `APP_ORIGIN` ;
3. jeton CSRF lié à la session, envoyé dans l'en-tête `X-CSRF-Token` et comparé en temps constant.

**Path traversal**
- Les fichiers sont stockés sous `data/files/<uuid>`, avec un UUID généré par le serveur. **Aucun
  nom saisi par un utilisateur n'entre dans un chemin disque.** L'identifiant est validé par regex
  et le chemin résolu est revérifié contre la racine.
- Les noms (affichés uniquement) sont normalisés et filtrés : caractères de contrôle, `/ \ < > : " | ? *`,
  `.` et `..` sont refusés.

**XSS / contenu malveillant**
- CSP stricte : `script-src 'self'`, sans `unsafe-inline` ni `unsafe-eval` (PDF.js tourne avec
  `isEvalSupported: false`). Côté interface, tout le DOM est construit via `textContent`, jamais
  `innerHTML`.
- Liste blanche d'extensions. Le **contenu est vérifié** par signature (« magic bytes ») : un faux
  `.pdf` est refusé.
- Seuls les PDF et images matricielles sont servis *inline* ; tout le reste part en
  `Content-Disposition: attachment` + `Content-Type: application/octet-stream` + CSP `sandbox`.
  `X-Content-Type-Options: nosniff` est présent partout. Les SVG et HTML sont interdits.

**Conteneur** : utilisateur non-root, système de fichiers en lecture seule, `cap_drop: ALL`,
`no-new-privileges`, port publié uniquement sur `127.0.0.1`.

---

## 3. Démarrage rapide (développement)

```bash
npm install
COOKIE_SECURE=false ADMIN_PASSWORD=changez-moi-svp npm run dev
# → http://localhost:3000  (admin / changez-moi-svp)
npm test
```

## 4. Déploiement avec Docker

```bash
git clone <ce dépôt> cours && cd cours
cp .env.example .env        # éditez APP_ORIGIN, ADMIN_PASSWORD, PUBLIC_READ…
docker compose up -d --build
docker compose logs app     # affiche le mot de passe admin s'il a été généré
```

L'application écoute alors sur `127.0.0.1:3000`. Elle n'est pas joignable depuis l'extérieur tant
qu'un reverse-proxy HTTPS n'est pas en place (voir ci-dessous).

> Test local sans HTTPS : mettez `COOKIE_SECURE=false` et `APP_ORIGIN=http://localhost:3000`
> dans `.env`, sinon le navigateur refusera le cookie de session.

### Gestion des comptes

```bash
docker compose exec app node scripts/users.js list
docker compose exec app node scripts/users.js add prof2 admin      # mot de passe demandé
docker compose exec app node scripts/users.js add eleve viewer
docker compose exec app node scripts/users.js passwd admin         # réinitialisation
docker compose exec app node scripts/users.js role eleve admin
docker compose exec app node scripts/users.js delete eleve
```

### Sauvegarde / restauration

Toutes les données se trouvent dans le volume `cours-data` (base + fichiers) :

```bash
# Sauvegarde (cohérente : la base est copiée via l'API de sauvegarde SQLite)
docker compose exec app node -e "require('better-sqlite3')('/data/app.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker run --rm -v cours_cours-data:/data -v "$PWD":/out busybox \
  tar czf /out/cours-$(date +%F).tgz -C /data backup.db files
# Restauration : arrêtez l'app, recopiez files/ et backup.db (renommé app.db) dans le volume.
```

(Le nom exact du volume est visible avec `docker volume ls`.)

---

## 5. Accès Internet en HTTPS

Dans tous les cas, renseignez dans `.env` :

```ini
APP_ORIGIN=https://cours.exemple.fr   # URL publique exacte
TRUST_PROXY=1                         # un proxy de confiance devant l'app
COOKIE_SECURE=true
```

### Option A : Nginx + Let's Encrypt (serveur avec IP publique)

1. DNS : un enregistrement `A`/`AAAA` `cours.exemple.fr` pointant vers le serveur, ports 80/443 ouverts.
2. `docker compose up -d --build` (l'app écoute sur `127.0.0.1:3000`).
3. Copiez [`deploy/nginx/cours.conf`](deploy/nginx/cours.conf) dans `/etc/nginx/sites-available/`,
   remplacez `cours.exemple.fr`, activez le site, puis `sudo certbot --nginx -d cours.exemple.fr`.
4. `client_max_body_size` doit être ≥ `MAX_UPLOAD_MB`.

### Option B : Traefik (tout en Docker, certificats automatiques)

```bash
# .env : DOMAIN=cours.exemple.fr  ACME_EMAIL=vous@exemple.fr  (+ les 3 variables ci-dessus)
docker compose -f docker-compose.yml -f deploy/traefik/docker-compose.traefik.yml up -d --build
```

### Option C : Cloudflare Tunnel (serveur à la maison, aucun port à ouvrir)

1. Cloudflare Zero Trust → *Networks → Tunnels → Create a tunnel* → copiez le jeton dans
   `.env` (`TUNNEL_TOKEN=…`).
2. *Public Hostname* : `cours.exemple.fr` → service `HTTP` → `app:3000`.
3. Lancez :
   ```bash
   docker compose -f docker-compose.yml -f deploy/cloudflared/docker-compose.cloudflared.yml up -d --build
   ```
4. Le plan gratuit limite les requêtes à 100 Mo : gardez `MAX_UPLOAD_MB` ≤ 95.

Pour un site entièrement privé, vous pouvez aussi ajouter devant une application
*Cloudflare Access* (connexion par e-mail) en plus de `PUBLIC_READ=false`.

---

## 6. Configuration

| Variable              | Défaut                 | Description                                                  |
|-----------------------|------------------------|--------------------------------------------------------------|
| `PUBLIC_READ`         | `true`                 | `false` = connexion obligatoire pour consulter              |
| `ADMIN_USERNAME`      | `admin`                | compte créé au premier démarrage                             |
| `ADMIN_PASSWORD`      | *(généré)*             | mot de passe initial (sinon généré et affiché dans les logs) |
| `APP_ORIGIN`          | *(déduit de la requête)* | URL publique, utilisée pour la vérification de l'en-tête `Origin` |
| `TRUST_PROXY`         | `false`                | nombre de proxys de confiance (`1` derrière Nginx/Traefik/cloudflared) |
| `COOKIE_SECURE`       | `true` en production   | cookie `Secure` + préfixe `__Host-` + HSTS                   |
| `SESSION_TTL_HOURS`   | `24`                   | durée d'une session                                          |
| `LOGIN_RATE_LIMIT`    | `10`                   | échecs de connexion autorisés / 15 min / IP                  |
| `MAX_UPLOAD_MB`       | `100`                  | taille maximale par fichier                                  |
| `MAX_FILES_PER_UPLOAD`| `50`                   | fichiers par requête                                         |
| `ALLOWED_EXTENSIONS`  | pdf, images, bureautique… | liste blanche (voir `.env.example`)                       |
| `SITE_TITLE`          | `Prépa TSI · Cours`    | titre affiché                                                |
| `DATA_DIR`            | `./data` (`/data` en Docker) | emplacement de la base et des fichiers                 |
| `PORT`                | `3000`                 | port d'écoute                                                |
