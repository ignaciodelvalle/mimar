export type DniVerifyResult = { ok: true } | { ok: false; error: string };

export type DniVerifyFormState = {
  error: string | null;
  ok?: boolean;
  next?: string;
};
