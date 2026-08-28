export type IDType =
  | "national_id"
  | "drivers_license"
  | "passport"
  | "student_id"
  | "work_id"
  | "other";

export type LostStatus = "searching" | "matched" | "recovered";
export type FoundStatus = "unclaimed" | "matched" | "returned";

// Matches the fields returned by GET /IDfinder in idfinder_backend.py.
// Note: reporter_email, reporter_phone and id_number_hint are NEVER returned
// by the API. The last-4 hint is withheld because it doubles as the match
// key -- publishing it let anyone forge a match and be sent the other
// party's contact details. Contact details only ever arrive via SMS once a
// match is confirmed.
export type IDRecord = {
  record_id: string;
  record_type: "lost" | "found";
  name_on_id: string;
  id_type: IDType;
  location: string;
  description?: string;
  status: "pending" | "matched";
  created_at: string;
};

// Kept as aliases so existing component code (LostStatus/FoundStatus refs)
// doesn't need to change everywhere.
export type LostIDRecord = IDRecord;
export type FoundIDRecord = IDRecord;

const BASE = import.meta.env.VITE_IDFINDER_API_BASE as string;

function assertBase() {
  if (!BASE) throw new Error("VITE_IDFINDER_API_BASE is not set");
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  assertBase();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data as T;
}

// ---------- LIST ----------
// Public -- anyone can browse without signing in, matching the original
// app's behaviour. The privacy fix lives in the API response shape, not an
// auth gate: idfinder_backend.py never returns reporter_email or
// reporter_phone here under any circumstances, logged in or not. Contact
// details only ever reach either party via SMS once a match is confirmed.
async function listByType(recordType: "lost" | "found"): Promise<IDRecord[]> {
  const resp = await apiFetch<{ success: true; items: IDRecord[] }>(
    `/IDfinder?record_type=${recordType}`,
    { method: "GET" }
  );

  return [...(resp.items ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function listLostIDs(): Promise<IDRecord[]> {
  return listByType("lost");
}

export async function listFoundIDs(): Promise<IDRecord[]> {
  return listByType("found");
}

// ---------- CREATE ----------
// Public -- no auth required, matching the report forms which don't require
// login. Contact fields (reporter_email/reporter_phone) are written but
// never returned by GET; they're only used server-side to send a match SMS.
export type CreateRecordInput = {
  name_on_id: string;
  reporter_name: string;
  reporter_email: string;
  reporter_phone: string;
  id_type: IDType;
  id_number_hint?: string;
  location: string;
  description?: string;
  // S3 key returned by the /save Lambda, when a photo was attached.
  photo_key?: string;
};

export async function createLostID(input: CreateRecordInput): Promise<{ record_id: string }> {
  return apiFetch(`/IDfinder`, {
    method: "POST",
    body: JSON.stringify({ record_type: "lost", ...input }),
  });
}

export async function createFoundID(input: CreateRecordInput): Promise<{ record_id: string }> {
  return apiFetch(`/IDfinder`, {
    method: "POST",
    body: JSON.stringify({ record_type: "found", ...input }),
  });
}
