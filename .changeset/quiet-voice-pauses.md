---
'aicodeman': patch
---

Add a configurable voice silence timeout and manual-stop dictation so thinking pauses do not cut off recording.

Provider-default Deepgram and Web Speech final events now wait for the 3-second silence deadline instead of stopping immediately. Claude keeps recording across utterance endpoints and preserves final words after Stop, with a bounded wait on failed connections.

Fix repeated words and lost final transcripts on Chrome for Android, animate browser speech activity without a competing microphone capture, and preserve partial text when reconnecting. Bound restarts of a browser recognizer that keeps ending instantly without a result, while silent runs of normal length keep 30-second and Manual dictation going.
