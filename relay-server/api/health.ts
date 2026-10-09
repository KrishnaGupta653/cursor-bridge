import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ApiResponse } from '../lib/types.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Device-Type');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const response: ApiResponse<{ status: string }> = {
    success: true,
    data: { status: 'healthy' },
    timestamp: Date.now(),
  };
  
  return res.status(200).json(response);
}
