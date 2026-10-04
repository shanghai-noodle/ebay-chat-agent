import { ListingDraft } from '../types/draft';

export class DraftStore {
  constructor(private kv: KVNamespace) {}

  private getKey(spaceId: string, threadKey: string): string {
    return `draft:${spaceId}:${threadKey}`;
  }

  async getDraft(spaceId: string, threadKey: string): Promise<ListingDraft | null> {
    const data = await this.kv.get(this.getKey(spaceId, threadKey), 'json');
    return (data as ListingDraft) || null;
  }

  async getDraftById(draftId: string): Promise<ListingDraft | null> {
    const data = await this.kv.get(`draft:id:${draftId}`, 'json');
    return (data as ListingDraft) || null;
  }

  async saveDraft(draft: ListingDraft): Promise<void> {
    draft.updatedAt = Date.now();
    const json = JSON.stringify(draft);
    const ttl = 60 * 60 * 24 * 7; // 7 days
    await Promise.all([
      this.kv.put(this.getKey(draft.spaceId, draft.threadKey), json, { expirationTtl: ttl }),
      this.kv.put(`draft:id:${draft.id}`, json, { expirationTtl: ttl }),
    ]);
  }

  async deleteDraft(spaceId: string, threadKey: string, draftId?: string): Promise<void> {
    const promises = [this.kv.delete(this.getKey(spaceId, threadKey))];
    if (draftId) {
      promises.push(this.kv.delete(`draft:id:${draftId}`));
    }
    await Promise.all(promises);
  }
}
