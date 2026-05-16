# RefugeCloud Runbook

## Post-deploy smoke test

After deploying or restarting the production service, run the read-only smoke test from the project root:

```bash
npm run smoke
```

Check service status:

```bash
sudo systemctl status refugecloud --no-pager
```

Review recent service logs without printing environment values:

```bash
sudo journalctl -u refugecloud -n 80 --no-pager
```
