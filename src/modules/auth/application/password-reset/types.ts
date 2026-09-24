export type PasswordResetRequestState = {
  message: string | null;
  error: string | null;
  /**
   * The address the request was made for, echoed back so the code step can send
   * it with the code (`verifyOtp` needs both). It is what the person typed, never
   * anything learned about an account.
   */
  email?: string;
};

export type UpdatePasswordState = {
  error: string | null;
  ok?: boolean;
};
