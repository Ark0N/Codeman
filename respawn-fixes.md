
### Fix for Issue #65
**Send/wait state stuck**

Stuck in waiting_update - the controller is trying to send a command but may not be receiving expected response.

Check terminal output:
```bash
curl -sk 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/terminal?tail=10000' | tail -100
```

Try restarting respawn:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/stop'
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/start'
```


### Fix for Issue #66
**Send/wait state stuck**

Stuck in waiting_update - the controller is trying to send a command but may not be receiving expected response.

Check terminal output:
```bash
curl -sk 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/terminal?tail=10000' | tail -100
```

Try restarting respawn:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/stop'
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/start'
```

