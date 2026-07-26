/**
 * enrollmentClient — push an on-device enrollment (embedding + details) to the
 * central backend when online. Enrollment is designed as an ONLINE event so the
 * admin console sees every inspector; the template is still saved locally too,
 * so verification works OFFLINE afterwards. Best-effort: failure here never
 * blocks the local enrollment.
 */
import type {Embedding} from '../face/math';

export interface PushEnrollmentInput {
  baseUrl: string; // backend origin (no /api path)
  apiKey: string;
  userId: string;
  embedding: Embedding;
  deviceId: string;
  samples: number;
  name?: string;
  role?: string;
  fetchImpl?: typeof fetch;
}

export interface PushEnrollmentResult {
  ok: boolean;
  error?: string;
}

export async function pushEnrollment(
  input: PushEnrollmentInput,
): Promise<PushEnrollmentResult> {
  const fetcher = input.fetchImpl ?? fetch;
  try {
    const res = await fetcher(`${input.baseUrl}/api/enroll`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-api-key': input.apiKey},
      body: JSON.stringify({
        userId: input.userId,
        name: input.name ?? input.userId,
        role: input.role,
        embedding: Array.from(input.embedding),
        deviceId: input.deviceId,
        samples: input.samples,
      }),
    });
    if (!res.ok) {
      return {ok: false, error: `HTTP ${res.status}`};
    }
    return {ok: true};
  } catch (e) {
    return {ok: false, error: e instanceof Error ? e.message : 'network error'};
  }
}
