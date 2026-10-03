// app/api/auth/route.ts
import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export async function POST(req: Request) {
  try {
    // 1. Attempt database connection with logging
    console.log('Connecting to database...');
    await dbConnect();
    console.log('Database connected successfully.');

    const body = await req.json();
    const { action, nickname, password } = body;

    if (!action || !nickname || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (action === 'signup') {
      const existingUser = await User.findOne({ nickname });
      if (existingUser) {
        return NextResponse.json({ error: 'Nickname already exists' }, { status: 400 });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const userCount = await User.countDocuments();
      const role = userCount === 0 ? 'chief' : 'clansman';
      const status = userCount === 0 ? 'approved' : 'pending';

      await User.create({
        nickname,
        passwordHash,
        role,
        status,
      });

      return NextResponse.json({ 
        success: true, 
        message: userCount === 0 ? 'Registered as Chief!' : 'Account created. Waiting for Chief approval.' 
      });
    }

    if (action === 'signin') {
      const user = await User.findOne({ nickname });
      if (!user) {
        return NextResponse.json({ error: 'Invalid nickname or password' }, { status: 400 });
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        return NextResponse.json({ error: 'Invalid nickname or password' }, { status: 400 });
      }

      if (user.status !== 'approved') {
        return NextResponse.json({ error: 'Your account is pending Chief approval.' }, { status: 403 });
      }

      const token = jwt.sign(
        { userId: user._id, nickname: user.nickname, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      const cookieStore = await cookies();
      cookieStore.set({
        name: 'token',
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });

      return NextResponse.json({ success: true, role: user.role, nickname: user.nickname });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('API Auth Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}