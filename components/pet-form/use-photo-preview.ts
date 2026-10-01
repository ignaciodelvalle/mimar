"use client";

// The preview a photo field shows, and what happens to it when the server
// refuses the submit.
//
// React 19 resets a `<form action>`'s uncontrolled fields once its action
// settles, refusal included. The file input is therefore EMPTY after a refused
// save while a preview kept in state would still show the chosen picture: the
// screen claims a file that the next submit will not send. `refusal` is the
// action's answer when it was a refusal (a fresh object per answer, so two
// identical messages in a row still reset); the preview goes back to what the
// credential already has.

import { useEffect, useRef, useState } from "react";

function revoke(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

export function usePhotoPreview(existingPhotoUrl: string | null, refusal: unknown) {
  const [preview, setPreview] = useState<string | null>(existingPhotoUrl);
  const current = useRef(preview);
  current.current = preview;

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    revoke(current.current);
    setPreview(file ? URL.createObjectURL(file) : existingPhotoUrl);
  }

  useEffect(() => {
    if (!refusal) return;
    revoke(current.current);
    setPreview(existingPhotoUrl);
  }, [refusal, existingPhotoUrl]);

  // Leaving the form releases the last picture.
  useEffect(() => () => revoke(current.current), []);

  return { preview, onFileChange };
}
