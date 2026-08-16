import { Amplify } from "aws-amplify";

// All values come from Terraform outputs -- see terraform/cognito.tf and
// terraform/amplify.tf, which inject these as Amplify Hosting environment
// variables at build time. Never hardcode a real pool/client ID here.
const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as
  | string
  | undefined;
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID as
  | string
  | undefined;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as
  | string
  | undefined;
const redirectUrlsRaw = import.meta.env.VITE_COGNITO_REDIRECT_URLS as
  | string
  | undefined;

if (!userPoolId || !userPoolClientId || !cognitoDomain || !redirectUrlsRaw) {
  // Don't throw here: an uncaught error at module-import time (before
  // React even mounts) blanks the entire page with nothing but a console
  // error -- confusing to debug. Warn instead and skip configuring Auth,
  // so the rest of the UI still renders. Sign-in won't work until a real
  // .env is in place (copy frontend/.env.example and fill in `terraform
  // output` values), but browsing/reporting-page-redirect-to-login will
  // simply no-op instead of crashing.
  console.warn(
    "[cognitoConfig] Missing one or more VITE_COGNITO_* env vars -- " +
      "sign-in will not work until you copy .env.example to .env and " +
      "fill in real values (see GETTING_STARTED.md)."
  );
} else {
  const redirectUrls = redirectUrlsRaw.split(",").map((s) => s.trim());

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          oauth: {
            domain: cognitoDomain,
            scopes: ["openid", "email"],
            redirectSignIn: redirectUrls,
            redirectSignOut: redirectUrls,
            responseType: "code",
          },
        },
      },
    },
  });
}