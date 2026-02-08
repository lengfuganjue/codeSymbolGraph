import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenFileTracker } from '../../src/lsp/open-file-tracker.js';

// Mock LspClient
function createMockClient() {
    return {
        didOpen: vi.fn().mockResolvedValue(undefined),
        didChange: vi.fn().mockResolvedValue(undefined),
        didClose: vi.fn().mockResolvedValue(undefined),
        didSave: vi.fn().mockResolvedValue(undefined),
    } as any;
}

describe('OpenFileTracker', () => {
    let tracker: OpenFileTracker;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(() => {
        tracker = new OpenFileTracker();
        client = createMockClient();
    });

    describe('notifyChange', () => {
        it('should call didOpen on first change', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'content');

            expect(client.didOpen).toHaveBeenCalledOnce();
            expect(client.didOpen).toHaveBeenCalledWith('file:///test.cs', 'csharp', 'content');
            expect(client.didChange).not.toHaveBeenCalled();
        });

        it('should call didChange on subsequent changes', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v1');
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v2');

            expect(client.didOpen).toHaveBeenCalledOnce();
            expect(client.didChange).toHaveBeenCalledOnce();
            expect(client.didChange).toHaveBeenCalledWith('file:///test.cs', 'v2', 2);
        });

        it('should increment version on each change', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v1');
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v2');
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v3');

            expect(client.didChange).toHaveBeenCalledTimes(2);
            expect(client.didChange).toHaveBeenNthCalledWith(1, 'file:///test.cs', 'v2', 2);
            expect(client.didChange).toHaveBeenNthCalledWith(2, 'file:///test.cs', 'v3', 3);
        });

        it('should track different files independently', async () => {
            await tracker.notifyChange(client, 'file:///a.cs', 'csharp', 'a');
            await tracker.notifyChange(client, 'file:///b.lua', 'lua', 'b');

            expect(client.didOpen).toHaveBeenCalledTimes(2);
            expect(client.didChange).not.toHaveBeenCalled();
            expect(tracker.openCount).toBe(2);
        });
    });

    describe('notifySave', () => {
        it('should call didSave for open files', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'content');
            await tracker.notifySave(client, 'file:///test.cs');

            expect(client.didSave).toHaveBeenCalledOnce();
        });

        it('should not call didSave for files not opened', async () => {
            await tracker.notifySave(client, 'file:///unknown.cs');
            expect(client.didSave).not.toHaveBeenCalled();
        });
    });

    describe('notifyDelete', () => {
        it('should call didClose for open files', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'content');
            await tracker.notifyDelete(client, 'file:///test.cs');

            expect(client.didClose).toHaveBeenCalledOnce();
            expect(tracker.isOpen('file:///test.cs')).toBe(false);
            expect(tracker.openCount).toBe(0);
        });

        it('should not call didClose for files not opened', async () => {
            await tracker.notifyDelete(client, 'file:///unknown.cs');
            expect(client.didClose).not.toHaveBeenCalled();
        });

        it('should allow re-open after delete', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v1');
            await tracker.notifyDelete(client, 'file:///test.cs');
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v2');

            expect(client.didOpen).toHaveBeenCalledTimes(2);
        });
    });

    describe('isOpen / openCount', () => {
        it('should track open state correctly', async () => {
            expect(tracker.isOpen('file:///test.cs')).toBe(false);
            expect(tracker.openCount).toBe(0);

            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'content');
            expect(tracker.isOpen('file:///test.cs')).toBe(true);
            expect(tracker.openCount).toBe(1);
        });
    });

    describe('reset', () => {
        it('should clear all open files', async () => {
            await tracker.notifyChange(client, 'file:///a.cs', 'csharp', 'a');
            await tracker.notifyChange(client, 'file:///b.lua', 'lua', 'b');

            tracker.reset();

            expect(tracker.openCount).toBe(0);
            expect(tracker.isOpen('file:///a.cs')).toBe(false);
            expect(tracker.isOpen('file:///b.lua')).toBe(false);
        });

        it('should treat next change as new open after reset', async () => {
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v1');
            tracker.reset();
            await tracker.notifyChange(client, 'file:///test.cs', 'csharp', 'v2');

            // didOpen should be called twice (before reset + after reset)
            expect(client.didOpen).toHaveBeenCalledTimes(2);
        });
    });
});
