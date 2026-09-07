import { initializeStorage, storageStatus } from '../../db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await initializeStorage();
    await storageStatus();
    return Response.json(
      { status: 'ready' },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      },
    );
  }
}
