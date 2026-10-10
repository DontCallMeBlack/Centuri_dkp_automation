import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';
import { getSheetRoster } from '@/lib/googleSheets';
import { normalizeAuctionRole } from '@/lib/auctionRules';
import {
  MAX_AUCTION_ITEM_IMAGE_BYTES,
  optimizeAuctionImage,
} from '@/lib/auctionImage';

const MAX_UPLOAD_IMAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 2 * 1024 * 1024;
const BOSS_TYPES = ['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Unassigned'] as const;
type BossType = (typeof BOSS_TYPES)[number];

function isBossType(value: string): value is BossType {
  return BOSS_TYPES.some((bossType) => bossType === value);
}

function canManageItems(role: string) {
  return role === 'chief' || role === 'general' || role === 'guardian';
}

async function getValidRoles(value: FormDataEntryValue[]) {
  const requested = value.filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((role) => role.trim())
    .filter(Boolean);
  const unique = [...new Set(requested.map(normalizeAuctionRole))];
  if (unique.length === 0 || unique.length > 2) return null;
  const roster = await getSheetRoster({ fresh: true });
  const roles = [...new Map(roster.map((record) => [normalizeAuctionRole(record.subClass), record.subClass.trim()])).entries()];
  const resolved = unique.map((key) => roles.find(([roleKey]) => roleKey === key)?.[1]);
  return resolved.every(Boolean) ? resolved as string[] : null;
}

export const dynamic = 'force-dynamic';

function verifyImageType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

async function readOptimizedImages(form: FormData) {
  const files = form.getAll('images');
  if (files.some((file) => !(file instanceof File))) {
    throw new Error('Every uploaded item image must be a file.');
  }
  if (files.length === 0) return null;
  if (files.length > 8) throw new Error('Upload no more than 8 images per item.');

  const totalUploadBytes = files.reduce(
    (total, file) => total + (file instanceof File ? file.size : 0),
    0,
  );
  if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
    throw new Error('The optimized images must total no more than 2 MB per item.');
  }

  const images: Array<{ data: Buffer; contentType: 'image/webp' }> = [];
  let totalStoredBytes = 0;
  for (const file of files) {
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error('Each optimized upload must be no larger than 1 MB.');
    }
    const imageBytes = new Uint8Array(await file.arrayBuffer());
    if (verifyImageType(imageBytes) !== file.type) {
      throw new Error('An uploaded image is invalid or does not match its file type.');
    }
    const optimizedImage = await optimizeAuctionImage(imageBytes);
    totalStoredBytes += optimizedImage.byteLength;
    if (totalStoredBytes > MAX_AUCTION_ITEM_IMAGE_BYTES) {
      throw new Error('The optimized images exceed 150 KB total for this item.');
    }
    images.push({ data: optimizedImage, contentType: 'image/webp' });
  }
  return images;
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    const [items, roster] = await Promise.all([
      AuctionItem.find({ isListed: { $ne: false } }).select('name requiredRoles requiredRole bossType imageCount').sort({ name: 1 }).lean(),
      getSheetRoster(),
    ]);
    const roles = [...new Set(
      roster.map((record) => record.subClass.trim().replace(/\s+/g, ' ')).filter(Boolean),
    )].sort((first, second) => first.localeCompare(second, undefined, { sensitivity: 'base' }));
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
    const message = error instanceof Error ? error.message : 'Unable to load saved items';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    const form = await request.formData();
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
      return NextResponse.json({ error: 'Choose one or two roles currently listed in the Google Sheets roster.' }, { status: 400 });
    }
    const images = await readOptimizedImages(form);
    if (!images?.length) {
      return NextResponse.json({ error: 'A new catalog item needs at least one image.' }, { status: 400 });
    }

    const item = await AuctionItem.create({
      name: name.trim(),
      requiredRoles: selectedRoles,
      bossType,
      images,
      imageCount: images.length,
      createdBy: user.nickname,
    });
    return NextResponse.json({ success: true, id: item._id.toString() });
  } catch (error: unknown) {
    if (error instanceof mongoose.Error.ValidationError || isDuplicateKeyError(error)) {
      return NextResponse.json({ error: 'An item with that name already exists.' }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Unable to create catalog item';
    const isClientError = /image|upload|file/i.test(message);
    return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}

export async function PATCH(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    const form = await request.formData();
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
      return NextResponse.json({ error: 'Choose one or two roles currently listed in the Google Sheets roster.' }, { status: 400 });
    }
    const images = await readOptimizedImages(form);
    const item = await AuctionItem.findById(itemId);
    if (!item) return NextResponse.json({ error: 'Catalog item not found.' }, { status: 404 });
    if (item.isListed === false) return NextResponse.json({ error: 'This item is no longer in the catalog.' }, { status: 404 });

    item.name = name.trim();
    item.requiredRoles = selectedRoles;
    item.requiredRole = selectedRoles[0];
    item.bossType = bossType;
    if (images) {
      item.images = images;
      item.imageCount = images.length;
      item.image = undefined;
      item.imageType = undefined;
    }
    await item.save();
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof mongoose.Error.ValidationError || isDuplicateKeyError(error)) {
      return NextResponse.json({ error: 'An item with that name already exists.' }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Unable to update catalog item';
    const isClientError = /image|upload|file/i.test(message);
    return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}

export async function DELETE(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageItems(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    const body: unknown = await request.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('itemId' in body) ||
      typeof body.itemId !== 'string' ||
      !mongoose.isValidObjectId(body.itemId)
    ) {
      return NextResponse.json({ error: 'Invalid catalog item ID.' }, { status: 400 });
    }

    const item = await AuctionItem.findOneAndUpdate(
      { _id: body.itemId, isListed: { $ne: false } },
      { $set: { isListed: false } },
      { new: true },
    );
    if (!item) return NextResponse.json({ error: 'Catalog item not found.' }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to remove catalog item';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
