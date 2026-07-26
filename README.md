# LeadFinder Pro — Cloudflare public, sans admin

Cette version est faite pour ton besoin actuel :

- pas de `wrangler.toml` ;
- pas de `package.json` ;
- pas de mot de passe admin ;
- pas de bouton Token admin ;
- pas de `ADMIN_TOKEN` ;
- pas d'API de récupération de leads à configurer.

## Structure

```text
leadfinder-cloudflare-v6-public/
├── public/
│   ├── index.html
│   └── _headers
├── functions/
│   └── api/
│       └── [[path]].js
├── schema.sql
└── README.md
```

## Important

Cette version est **publique** : toute personne qui connaît ton lien Cloudflare pourra utiliser le scanner et voir les leads.

Si plus tard tu veux protéger l'outil, il faudra remettre un système de mot de passe ou utiliser Cloudflare Access.

## Sources disponibles sans API de lead

### Directes sans clé

- Freelancer.com
- Reddit public
- Hacker News
- RSS/Atom personnalisés

### Scraping public + sitemap public

- Upwork
- Fiverr
- Malt
- ComeUp
- LinkedIn
- Facebook Groups
- Indeed
- PeoplePerHour
- Guru
- Toptal
- Behance
- Dribbble

La plateforme respecte `robots.txt`. Si une source bloque ou interdit l'accès, elle affichera l'erreur dans le tableau de statut.

## Déploiement depuis Cloudflare Dashboard, sans Wrangler

### 1. Mets le dossier sur GitHub

Ton repo doit contenir à la racine :

```text
public/
functions/
schema.sql
README.md
```

### 2. Crée la base D1

Dans Cloudflare :

```text
Workers & Pages > D1 SQL Database > Create database
```

Nom conseillé :

```text
leadfinder-db
```

Ensuite ouvre la base, va dans SQL/Console, colle le contenu de :

```text
schema.sql
```

Puis exécute.

### 3. Crée le projet Pages

Dans Cloudflare :

```text
Workers & Pages > Pages > Create application > Connect to Git
```

Paramètres :

```text
Framework preset: None
Build command: laisser vide
Build output directory: public
Root directory: /
```

### 4. Ajoute le binding D1

Dans ton projet Pages :

```text
Settings > Functions > D1 database bindings > Add binding
```

Mets exactement :

```text
Variable name: DB
D1 database: leadfinder-db
```

Sauvegarde puis redéploie.

## Utilisation

1. Ouvre ton URL Cloudflare Pages.
2. Va dans **Scanner**.
3. Coche les sources.
4. Lance une recherche.

Aucun token admin à coller.
