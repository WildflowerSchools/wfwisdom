---
name: Startup seeding budget
description: Why startup seeds need bounded database round trips.
---

Keep startup seed work small enough to finish before the HTTP readiness deadline, even over a remote database connection.

**Why:** A production publish timed out after approximately 60 seconds while sequential seed inserts were still running. The HTTP server had not yet started; migrations had succeeded and the SSL notices were not the failure.

**How to apply:** Batch inserts rather than adding one database round trip per seed row. Retain insert-if-missing behavior and taxonomy retirements so optimizing startup never overwrites staff edits or recreates removed categories. Development timing alone does not prove production timing.
