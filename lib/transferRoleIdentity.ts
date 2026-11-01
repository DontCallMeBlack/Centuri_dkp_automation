import type { ClientSession } from 'mongoose';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import { getSheetRecordKey } from './sheetRecordLinks';
import { RequestValidationError } from './security/request';

/** Keep the toon's existing role schedule/approval pairing intact across an
 * owner rename. Historical raid and completed-auction identities stay intact.
 */
export async function transferRoleIdentity(
  before: { owner: string; account: string }, after: { owner: string; account: string }, session: ClientSession,
) {
  const oldKey = getSheetRecordKey(before);
  const newKey = getSheetRecordKey(after);
  if (oldKey !== newKey && (await ToonRoleChange.exists({ identityKey: newKey }).session(session) ||
    await ToonRoleChangeRequest.exists({ identityKey: newKey }).session(session))) {
    throw new RequestValidationError('The destination toon identity already has role records. Reconcile those records before transferring.', 409);
  }
  await ToonRoleChange.updateOne({ identityKey: oldKey }, {
    $set: { identityKey: newKey, owner: after.owner, account: after.account },
  }, { session, timestamps: false });
  await ToonRoleChangeRequest.updateMany({ identityKey: oldKey }, {
    $set: { identityKey: newKey, owner: after.owner, account: after.account },
  }, { session, timestamps: false });
}
