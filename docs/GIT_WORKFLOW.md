# Git Workflow

Use branches:

```txt
main
dev
feature/<short-name>
fix/<short-name>
```

Normal flow:

```powershell
git checkout -b feature/backend-change
git status
git add .
git commit -m "Describe change"
git push origin feature/backend-change
```

Before commit:

```powershell
npm.cmd run check:syntax
npm.cmd run check:env
git status
```

Never commit:

```txt
db.json
.env
backups/
exports/
reports/
*.xlsx
```
