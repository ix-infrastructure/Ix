export async function GET(request: Request) { return Response.json({ok: true}); }
export const PATCH = async (request: Request) => Response.json({ok: true});
function POST(request: Request) { return Response.json({ok: false}); }
