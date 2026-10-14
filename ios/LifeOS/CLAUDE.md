# LifeOS iOS

App SwiftUI nativa che parla con il bridge (`../../bridge`). Progetto Xcode generato da `project.yml` (`xcodegen generate`).

## Versioni — regola da seguire sempre

Ogni modifica all'app, anche minima, è una nuova versione `MAJOR.MINOR.PATCH` registrata in `CHANGELOG.md`
(la legenda completa è lì). **Non modificare mai `VERSION`, `MARKETING_VERSION` o `CURRENT_PROJECT_VERSION` a mano**:

```bash
python3 scripts/bump-version.py <major|minor|patch> --added "..." --changed "..." --fixed "..."
```

- `major`: cambio che rompe la compatibilità o ridisegno completo (solo se l'utente lo decide).
- `minor`: funzione, sezione o integrazione nuova.
- `patch`: correzione di un errore o ritocco piccolo.
- Sale un solo numero, di uno, e i numeri a destra tornano a 0. Nel dubbio, il livello più basso.
- Lancia lo script dopo aver finito e verificato la modifica, con una voce chiara in italiano.

## Release su GitHub

Dopo bump, commit e push, pubblica la versione come release (tag `vX.Y.Z`, note prese da `CHANGELOG.md`):

```bash
python3 scripts/release.py          # --dry-run per vedere le note senza pubblicare
```

Rifiuta di partire con modifiche non committate o commit non spinti su `origin`.
