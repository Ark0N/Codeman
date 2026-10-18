---
'aicodeman': patch
---

An Antigravity (`agy`) tab now shows that it is working. Its spinner animates a braille set Codeman did not recognise and the entry declared no work detection, so a running turn never marked the tab working and the activity indicator stayed off. The entry now declares what a turn draws (`⣯  Generating...`, `Working...`, `Loading...`) and its footer hint (`? for shortcuts`) as the idle mark, so a finished turn reads as idle again. A shell call waiting for approval keeps showing as working until you answer it.
