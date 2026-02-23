# Next Steps

## 1. Test End-to-End Locally

Before publishing, fully test the polling flow:

```bash
npm run build
npm link                       # install globally from local folder

clautel setup          # enter bot token + your Telegram user ID
clautel start          # start daemon in background
clautel logs           # watch it boot up

# In Telegram:
# - DM your manager bot
# - Use /add to attach a worker bot to a project directory
# - Send a prompt to the worker bot and verify Claude responds
# - Test /model, /cost, /session, /cancel
# - Send a photo and a document

clautel stop
npm unlink -g clautel  # clean up when done
```

## 2. Check npm Package Name Availability

```bash
npm view clautel
```

- If it returns a 404 → name is free, proceed
- If it's taken → use a scoped name instead: change `"name"` in `package.json` to `"@anasnadeem/clautel"` and update the install instructions in README.md and install.sh

## 3. Merge to Main

```bash
git checkout main
git merge prod-polling
git push origin main
```

Make sure the GitHub repo is set to **public** so the curl install script works.

## 4. Publish to npm

```bash
npm login       # one-time — needs an account at npmjs.com
npm publish     # prepublishOnly will auto-run build first
```

After this, users can install via:

```bash
npm install -g clautel
# or
curl -fsSL https://raw.githubusercontent.com/AnasNadeem/clautel/main/install.sh | sh
```

## 5. Future Updates

When releasing a new version:

```bash
npm version patch   # 1.0.0 → 1.0.1  (bug fixes)
npm version minor   # 1.0.0 → 1.1.0  (new features)
npm version major   # 1.0.0 → 2.0.0  (breaking changes)
npm publish
git push origin main --tags
```

## Remaining Nice-to-Haves

- **Voice message support** — handle `message:voice` in worker.ts
- **Send files back to phone** — add `/send <filepath>` command to upload a file from the working directory to Telegram
- **Temp file cleanup on startup** — scan and remove leftover `.tmp-images/` dirs from a previous hard crash
