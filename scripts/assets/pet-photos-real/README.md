# Real pet photos — drop folder

Drop real photos here named by the pet's **public token**:

```
DIM-9HAK-D5Z4.jpg   → Firulais (caniche, owner@)
DIM-4SUZ-U2HT.jpg   → Michi (gata blanco y negro, owner@)
DIM-VT3V-SEA3.jpg   → Atún (siamés, owner@)
DIM-DEMO-0001.jpg   → Rocco (boxer/mestizo, owner@ — amended-event beat pet)
```

- Accepted extensions: `.jpg`, `.jpeg`, `.png`, `.webp`.
- Any size — the wire-up script center-crops and resizes to 1024×1024.
- Any pet token works, not just these four (adoptables, lost pets, etc.).

Then run:

```
pnpm seed:real-photos
```

The script uploads each file to the `pet-photos` Storage bucket, creates an
attachments row, and points `pets.primary_photo_id` at it — REPLACING any
generated placeholder. Idempotent: re-running re-uploads and re-points.

Files in this folder are gitignored (local demo assets, not repo content).
