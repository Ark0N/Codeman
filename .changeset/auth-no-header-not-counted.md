---
'aicodeman': patch
---

A request with no `Authorization` header always gets the `401` login challenge and is no longer counted as a failed login. After a server restart (cookie sessions live in memory) an open tab's background requests carry only the dead cookie; ten of them used to fill the per-IP bucket in seconds, and the `429` that followed carries no challenge, so the browser never asked for the password again and every user behind the same tunnel IP was locked out for the 15-minute decay. Wrong passwords and malformed `Authorization` headers are still counted and rate-limited as before, in both single-user and multi-user mode.
