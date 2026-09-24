---
"@jmfederico/pi-web": patch
---

Fix Pi sessions hanging on quit while their web permission bridge was being polled: the bridge force-closes client connections and bounds its shutdown wait, and the external permission bridge poller destroys its socket after each request instead of leaving the close to garbage collection.
