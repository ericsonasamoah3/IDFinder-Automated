import {
  signInWithRedirect,
  signOut,
  getCurrentUser,
} from "aws-amplify/auth";

export async function login() {
  await signInWithRedirect();
}

export async function logout() {
  await signOut();
}

export async function getUser() {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}