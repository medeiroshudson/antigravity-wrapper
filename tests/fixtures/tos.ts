/**
 * The 403 the backend answered on 2026-11-05 for eight accounts of the pool. Measured,
 * not invented: the account block is reported through `ErrorInfo.reason`, while the
 * message alone would be indistinguishable from a request-level refusal.
 *
 * The same process, client id and User-Agent served 200 for two fresh accounts in the
 * same minute, which is what makes this an account verdict and not a client one.
 */
export const TOS_APPEAL_URL = "https://forms.gle/hGzM9MEUv2azZsrb9";

export const TOS_VIOLATION_BODY = JSON.stringify({
  error: {
    code: 403,
    message:
      "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TOS_VIOLATION",
        domain: "cloudcode-pa.googleapis.com",
        metadata: {
          uiMessage: "true",
          appeal_url: TOS_APPEAL_URL,
          appeal_url_link_text: "Submit Appeal",
        },
      },
    ],
  },
});
