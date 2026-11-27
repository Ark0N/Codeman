---
"aicodeman": patch
---

The installer no longer stops on "Failed to obtain sudo privileges" in a headless run with a working passwordless sudo (`su - user -c`, cron, a CI runner, cloud-init): it now checks whether `/dev/tty` can be opened before taking sudo's input from it, where it used to test only that the node exists.
