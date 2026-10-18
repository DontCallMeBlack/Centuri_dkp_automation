import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import Auction from '@/lib/models/Auction';
import { normalizeAuctionBossType, ITEM_SUBROLES, resolveItemSubroles } from '@/lib/auctionRules';
import { getSessionUser } from '@/lib/auth/session';
import {
  MAX_AUCTION_ITEM_IMAGE_BYTES,
  MAX_AUCTION_UPLOAD_IMAGE_BYTES,
  AuctionImageError,
  verifyAuctionImageType,
  optimizeAuctionImage,
} from '@/lib/auctionImage';
import { guardMutationRequest, readJsonObject, readFormDataLimited, requestErrorResponse, RequestValidationError } from '@/lib/security/request';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import User from '@/lib/models/User';
import { limitMemberRequests } from '@/lib/auth/rateLimit';

const MAX_TOTAL_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_TOTAL_UPLOAD_BYTES + 128 * 1024;
const BOSS_TYPES = ['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Legacy', 'Unassigned'] as const;
type BossType = (typeof BOSS_TYPES)[number];

function isBossType(value: string): value is BossType {
  return BOSS_TYPES.some((bossType) => bossType === value);
}

function canManageItems(role: string) {
  return role === 'chief' || role === 'general' || role === 'guardian';
}

async function withItemManager<T>(userId: mongoose.Types.ObjectId, operation: (session: mongoose.ClientSession, nickname: string) => Promise<T>) {
  return withClanAdministrationTransaction(async (session) => {
    const actor = await User.findById(userId).select('nickname role status').session(session);
    if (!actor || actor.status !== 'approved') throw new RequestValidationError('Your session is no longer authorized.', 401);
    if (!canManageItems(actor.role)) throw new RequestValidationError('Permission denied.', 403);
    return operation(session, actor.nickname);
  });
}

async function getValidRoles(value: FormDataEntryValue[]) {
  if (value.length > 4 || value.some((entry) => typeof entry !== 'string' || entry.length > 512)) return null;
  const requested = value.filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((role) => role.trim())
    .filter(Boolean);
  return resolveItemSubroles(requested);
}

export const dynamic = 'force-dynamic';

async function readOptimizedImages(form: FormData) {
  const files = form.getAll('images');
  if (files.some((file) => !(file instanceof File))) {
    throw new RequestValidationError('Every uploaded item image must be a file.');
  }
  if (files.length === 0) return null;
  if (files.length > 8) throw new RequestValidationError('Upload no more than 8 images per item.');

  const totalUploadBytes = files.reduce(
    (total, file) => total + (file instanceof File ? file.size : 0),
    0,
  );
  if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
    throw new RequestValidationError('The optimized images must total no more than 2 MB per item.');
  }

  const images: Array<{ data: Buffer; contentType: 'image/webp' }> = [];
  let totalStoredBytes = 0;
  for (const file of files) {
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_AUCTION_UPLOAD_IMAGE_BYTES) {
      throw new RequestValidationError('Each optimized upload must be no larger than 1 MB.');
    }
    const imageBytes = new Uint8Array(await file.arrayBuffer());
    if (verifyAuctionImageType(imageBytes) !== file.type) {
      throw new RequestValidationError('An uploaded image is invalid or does not match its file type.');
    }
    const optimizedImage = await optimizeAuctionImage(imageBytes);
    totalStoredBytes += optimizedImage.byteLength;
    if (totalStoredBytes > MAX_AUCTION_ITEM_IMAGE_BYTES) {
      throw new RequestValidationError('The optimized images exceed 150 KB total for this item.');
    }
    images.push({ data: optimizedImage, contentType: 'image/webp' });
  }
  return images;
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    const items = await AuctionItem.find({ isListed: { $ne: false } }).select('name requiredRoles requiredRole bossType imageCount').sort({ name: 1 }).lean();
    const roles = ITEM_SUBROLES;
    return NextResponse.json({
      success: true,
      roles,
      items: items.map((item) => ({
        id: item._id.toString(),
        name: item.name,
        requiredRoles: item.requiredRoles?.length ? item.requiredRoles : item.requiredRole ? [item.requiredRole] : [],
        bossType: item.bossType ?? 'Unassigned',
        imageCount: item.imageCount ?? 1,
      })),
    });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load saved items. Please retry shortly.');
  }
}

export async function POST(request: Request) {
  const rejected = guardMutationRequest(request);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    await limitMemberRequests(user._id.toString(), 'catalog-write');
    const form = await readFormDataLimited(request, MAX_MULTIPART_BYTES);
    const name = form.get('name');
    const bossType = form.get('bossType');
    const requiredRolesInput = form.getAll('requiredRoles');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return NextResponse.json({ error: 'Enter an item name of 1 to 120 characters.' }, { status: 400 });
    }
    if (typeof bossType !== 'string' || !isBossType(bossType) || bossType === 'Unassigned') {
      return NextResponse.json({ error: 'Choose the boss type for this item.' }, { status: 400 });
    }
    const selectedRoles = await getValidRoles(requiredRolesInput);
    if (!selectedRoles) {
      return NextResponse.json({ error: 'Choose one or two supported subroles, or Everyone on its own.' }, { status: 400 });
    }
    const images = await readOptimizedImages(form);
    if (!images?.length) {
      return NextResponse.json({ error: 'A new catalog item needs at least one image.' }, { status: 400 });
    }

    const item = await withItemManager(user._id, async (session, nickname) => {
      const [created] = await AuctionItem.create([{
        name: name.trim(),
        requiredRoles: selectedRoles,
        bossType,
        images,
        imageCount: images.length,
        createdBy: nickname,
      }], { session });
      return created;
    });
    return NextResponse.json({ success: true, id: item._id.toString() });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ error: 'A listed catalog item already uses that name. Edit that item or choose another name.' }, { status: 409 });
    }
    if (error instanceof mongoose.Error.ValidationError) return NextResponse.json({ error: 'The item details are invalid. Check the name, roles, boss type, and images.' }, { status: 400 });
    if (error instanceof AuctionImageError) return NextResponse.json({ error: error.message }, { status: 400 });
    return requestErrorResponse(error, 'Unable to create catalog item. Please retry shortly.');
  }
}

export async function PATCH(request: Request) {
  const rejected = guardMutationRequest(request);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    await limitMemberRequests(user._id.toString(), 'catalog-write');
    const form = await readFormDataLimited(request, MAX_MULTIPART_BYTES);
    const itemId = form.get('itemId');
    const name = form.get('name');
    const bossType = form.get('bossType');
    const requiredRolesInput = form.getAll('requiredRoles');
    if (typeof itemId !== 'string' || !mongoose.isValidObjectId(itemId)) {
      return NextResponse.json({ error: 'Invalid catalog item ID.' }, { status: 400 });
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return NextResponse.json({ error: 'Enter an item name of 1 to 120 characters.' }, { status: 400 });
    }
    if (typeof bossType !== 'string' || !isBossType(bossType) || bossType === 'Unassigned') {
      return NextResponse.json({ error: 'Choose the boss type for this item.' }, { status: 400 });
    }
    const selectedRoles = await getValidRoles(requiredRolesInput);
    if (!selectedRoles) {
      return NextResponse.json({ error: 'Choose one or two supported subroles, or Everyone on its own.' }, { status: 400 });
    }
    const images = await readOptimizedImages(form);
    await withItemManager(user._id, async (session) => {
      const item = await AuctionItem.findById(itemId).session(session);
      if (!item || item.isListed === false) throw new RequestValidationError('Catalog item not found.', 404);

      if (images) {
        if (await Auction.exists({ itemId: item._id }).session(session)) {
          // Pin existing auctions to their original image set before changing
          // the listed catalog item. Auction IDs and all financial data stay.
          const [snapshot] = await AuctionItem.create([{
            name: item.name, requiredRoles: item.requiredRoles, requiredRole: item.requiredRole,
            bossType: normalizeAuctionBossType(item.bossType) ?? 'Unassigned',
            images: item.images.map((image) => ({ data: Buffer.from(image.data), contentType: image.contentType })),
            image: item.image, imageType: item.imageType, imageCount: item.imageCount,
            isListed: false, createdBy: item.createdBy, createdAt: item.createdAt,
          }], { session });
          await Auction.updateMany({ itemId: item._id }, { $set: { itemId: snapshot._id } }, { session, timestamps: false });
        }
        item.images = images;
        item.imageCount = images.length;
        item.image = undefined;
        item.imageType = undefined;
      }
      item.name = name.trim();
      item.requiredRoles = selectedRoles;
      item.requiredRole = selectedRoles[0];
      item.bossType = bossType;
      await item.save({ session });
    });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ error: 'A listed catalog item already uses that name. Edit that item or choose another name.' }, { status: 409 });
    }
    if (error instanceof mongoose.Error.ValidationError) return NextResponse.json({ error: 'The item details are invalid. Check the name, roles, boss type, and images.' }, { status: 400 });
    if (error instanceof AuctionImageError) return NextResponse.json({ error: error.message }, { status: 400 });
    return requestErrorResponse(error, 'Unable to update catalog item. Please retry shortly.');
  }
}

export async function DELETE(request: Request) {
  const rejected = guardMutationRequest(request);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    await limitMemberRequests(user._id.toString(), 'catalog-write');
    const body = await readJsonObject(request);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('itemId' in body) ||
      typeof body.itemId !== 'string' ||
      !mongoose.isValidObjectId(body.itemId)
    ) {
      return NextResponse.json({ error: 'Invalid catalog item ID.' }, { status: 400 });
    }

    const itemId = body.itemId;
    const item = await withItemManager(user._id, async (session) => AuctionItem.findOneAndUpdate(
      { _id: itemId, isListed: { $ne: false } },
      { $set: { isListed: false } },
      { new: true, session },
    ));
    if (!item) return NextResponse.json({ error: 'Catalog item not found.' }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to remove catalog item. Please retry shortly.');
  }
}
