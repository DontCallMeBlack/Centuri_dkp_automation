import mongoose from 'mongoose';
import { RequestValidationError } from '@/lib/security/request';

interface MongoCache { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null }
const globalWithMongo = globalThis as typeof globalThis & { centuriMongo?: MongoCache };
const cached = globalWithMongo.centuriMongo ??= { conn: null, promise: null };

export default async function dbConnect() {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    throw new RequestValidationError('Database access is disabled on preview deployments.', 503);
  }
  if (cached.conn?.connection.readyState === 1) return cached.conn;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MongoDB is not configured.');
  if (cached.conn && cached.conn.connection.readyState === 0) {
    cached.conn = null;
    cached.promise = null;
  }
  cached.promise ??= mongoose.connect(uri, {
    bufferCommands: false, family: 4,
    serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 25_000,
    maxPoolSize: 10, minPoolSize: 0, maxIdleTimeMS: 60_000,
  });
  try { cached.conn = await cached.promise; return cached.conn; }
  catch (error) { cached.promise = null; throw error; }
}
