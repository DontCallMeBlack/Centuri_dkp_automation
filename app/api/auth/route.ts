import bcrypt from 'bcryptjs';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import ClanAccountArchive from '@/lib/models/ClanAccountArchive';
import ClanAdministrationState from '@/lib/models/ClanAdministrationState';
import { createSession, revokeSession } from '@/lib/auth/session';
import { withClanAdministrationTransaction, CLAN_ADMINISTRATION_KEY } from '@/lib/auth/administration';
import { authRetryAfter } from '@/lib/auth/rateLimit';
import { normalizeNickname, validateSignup, validSigninInput } from '@/lib/auth/validation';
import { validBootstrapToken } from '@/lib/auth/bootstrap';
import { guardMutationRequest, readJsonObject, RequestValidationError, requestErrorResponse } from '@/lib/security/request';

const DUMMY_HASH = '$2b$12$NUrPcAoMZbi1TU6FU88ibuTkOweirolE6dghhJqpfRm.iVIL9iD46';
const privateHeaders = { 'Cache-Control': 'private, no-store' };
class SetupRequiredError extends RequestValidationError {
  constructor() { super('First Chief setup needs the private setup code from the site owner.', 503); }
}

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    const { action, nickname, password, bootstrapToken } = await readJsonObject(request, { maxBytes: 4096 });
    if (action !== 'signup' && action !== 'signin') throw new RequestValidationError('Select sign in or sign up.');
    if (!validSigninInput(nickname, password)) throw new RequestValidationError('Enter a valid nickname and password.');
    if (action === 'signup') {
      const error = validateSignup(nickname, password);
      if (error) throw new RequestValidationError(error);
    }
    await dbConnect();
    const retryAfter = await authRetryAfter(request, nickname, action);
    if (retryAfter) return Response.json({ error: 'Too many attempts. Please try again later.' }, {
      status: 429, headers: { ...privateHeaders, 'Retry-After': String(retryAfter) },
    });

    if (action === 'signup') {
      const displayName = nickname.trim().normalize('NFKC');
      const nicknameKey = normalizeNickname(nickname);
      const passwordHash = await bcrypt.hash(password as string, 12);
      const firstChief = await withClanAdministrationTransaction(async (session) => {
        // Check legacy accounts as well: new case/space variants must not hijack
        // historical names or split a member across duplicate identities.
        const existingNames = await User.find().select('nickname nicknameKey').session(session).lean();
        if (existingNames.some((user) => (user.nicknameKey || normalizeNickname(user.nickname)) === nicknameKey)) {
          throw new RequestValidationError('That nickname is already registered.', 409);
        }
        const archivedName = await ClanAccountArchive.exists({ nicknameKey, status: 'archived' }).session(session);
        if (archivedName) throw new RequestValidationError('That nickname is archived. Ask a Chief or General to restore the account.', 409);
        const archivedAccountCount = await ClanAccountArchive.countDocuments({ status: 'archived' }).session(session);
        const state = await ClanAdministrationState.findById(CLAN_ADMINISTRATION_KEY).session(session);
        const bootstrap = existingNames.length === 0 && archivedAccountCount === 0 && state?.bootstrapClaimed === false;
        if (existingNames.length === 0) {
          if (!bootstrap) throw new RequestValidationError('The clan has already been initialized. The site owner must recover its Chief account.', 503);
          if (!validBootstrapToken(bootstrapToken, process.env.CLAN_BOOTSTRAP_TOKEN)) throw new SetupRequiredError();
        }
        await ClanAdministrationState.updateOne({ _id: CLAN_ADMINISTRATION_KEY }, { $set: { bootstrapClaimed: true } }, { session });
        await User.create([{ nickname: displayName, nicknameKey, passwordHash,
          role: bootstrap ? 'chief' : 'clansman', status: bootstrap ? 'approved' : 'pending' }], { session });
        return bootstrap;
      });
      return Response.json({ success: true, message: firstChief
        ? 'Your Chief account is ready. Sign in to continue.'
        : 'Account created. A Chief or General will review your request.' }, { headers: privateHeaders });
    }

    // Exact legacy names stay usable, including old short passwords. New
    // accounts also support their normalized nickname key.
    const user = await User.findOne({ nickname }).lean()
      ?? await User.findOne({ nicknameKey: normalizeNickname(nickname) }).lean();
    const matched = await bcrypt.compare(password as string, user?.passwordHash || DUMMY_HASH);
    if (!user || !matched) return Response.json({ error: 'Invalid nickname or password.' }, { status: 401, headers: privateHeaders });
    if (user.status !== 'approved') return Response.json({ error: 'Your account is waiting for approval.' }, { status: 403, headers: privateHeaders });
    await revokeSession();
    await createSession(user._id);
    return Response.json({ success: true, role: user.role, nickname: user.nickname }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof SetupRequiredError) return Response.json({ error: error.message, needsSetup: true }, { status: 503, headers: privateHeaders });
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      return Response.json({ error: 'That nickname is already registered.' }, { status: 409, headers: privateHeaders });
    }
    return requestErrorResponse(error, 'Authentication is temporarily unavailable. Please retry.');
  }
}
