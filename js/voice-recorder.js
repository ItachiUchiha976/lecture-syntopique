// Enregistrement audio via le micro (getUserMedia + MediaRecorder).
// Sur iPad/Safari, le format natif est audio/mp4 (AAC, extension .m4a) — lu partout
// (Drive, Claude, Gemini, iPad). Repli WebM/Opus pour Chrome/Firefox sur PC (tests).
// Aucune conversion : on enregistre tel quel pour rester rapide et léger sur l'iPad.

// Choisit le meilleur type MIME supporté + l'extension de fichier correspondante.
export function pickMime() {
  const MR = typeof window !== 'undefined' ? window.MediaRecorder : null;
  const supported = (t) => { try { return !!(MR && MR.isTypeSupported && MR.isTypeSupported(t)); } catch { return false; } };
  const candidates = [
    { mime: 'audio/mp4', ext: 'm4a' },              // Safari / iPad (AAC) — priorité
    { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
    { mime: 'audio/webm;codecs=opus', ext: 'webm' }, // Chrome / Firefox (PC)
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ];
  for (const c of candidates) if (supported(c.mime)) return c;
  return { mime: '', ext: 'm4a' }; // laisse le navigateur décider (rare)
}

// Vérifie la disponibilité de l'API d'enregistrement.
export function isRecordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder !== 'undefined');
}

// Démarre un enregistrement. Retourne un contrôleur :
//   { stop(): Promise<{ blob, mime, ext, durationMs }>, cancel(): void, mime, ext }
// `stop()` arrête le micro (coupe les pistes) et résout avec le blob audio final.
export async function startRecording() {
  if (!isRecordingSupported()) {
    const err = new Error('Enregistrement audio non disponible sur ce navigateur.');
    err.code = 'unsupported';
    throw err;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // NotAllowedError (refus), NotFoundError (pas de micro)…
    const err = new Error(e && e.name === 'NotAllowedError'
      ? 'Accès au micro refusé. Autorise le micro dans les réglages du site.'
      : 'Impossible d’accéder au micro.');
    err.code = e && e.name ? e.name : 'mic-error';
    throw err;
  }

  const { mime, ext } = pickMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  rec.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });

  const startedAt = performance.now();
  rec.start();

  function stopTracks() { try { stream.getTracks().forEach((t) => t.stop()); } catch {} }

  return {
    mime: rec.mimeType || mime,
    ext,
    stop() {
      return new Promise((resolve, reject) => {
        rec.addEventListener('stop', () => {
          stopTracks();
          const outMime = rec.mimeType || mime || (chunks[0] && chunks[0].type) || 'audio/mp4';
          const blob = new Blob(chunks, { type: outMime });
          resolve({ blob, mime: outMime, ext, durationMs: Math.round(performance.now() - startedAt) });
        }, { once: true });
        rec.addEventListener('error', (e) => { stopTracks(); reject(e.error || new Error('Erreur d’enregistrement.')); }, { once: true });
        try { rec.stop(); } catch (e) { stopTracks(); reject(e); }
      });
    },
    cancel() { try { rec.stop(); } catch {} stopTracks(); },
  };
}
