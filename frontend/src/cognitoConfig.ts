import { Amplify } from "aws-amplify";

// All values come from Terraform outputs -- see terraform/cognito.tf and
// terraform/amplify.tf, which inject these as Amplify Hosting environment
// variables at build time. Never hardcode a real pool/client ID here.
const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string;
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string;
const redirectUrls = (import.meta.env.VITE_COGNITO_REDIRECT_URLS as string)
  .split(",")
  .map((s) => s.trim());

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