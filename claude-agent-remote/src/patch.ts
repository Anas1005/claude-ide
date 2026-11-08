// applyPatch: exact-match text edits across one or more files.
// Every edit must match exactly once (or replaceAll), every file is validated before anything is written, and each
// file is re-read just before its write so a concurrent change is reported as CONFLICT, never overwritten.
import { ApiResult, RemoteFsError, execute } from './core';
import { atomicWrite, checkExpected, describeWrite, resolveWriteTarget, reviewContents, sha256 } from './files';

export const MAX_PATCH_FILES = 20;
export const MAX_EDITS_PER_FILE = 100;

interface TextEdit { oldString: string; newString: string; replaceAll?: boolean }
interface FilePatch { path: string; edits: TextEdit[]; expectedSha256?: string }
interface ApplyPatchRequest { files: FilePatch[]; returnContent?: boolean; allowSensitive?: boolean }

function countOccurrences(text: string, needle: string): number {
    let count = 0;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
        count++;
    }
    return count;
}

/** Applies edits in order; throws CONFLICT naming the edit that did not match exactly once. */
export function applyEdits(text: string, edits: TextEdit[], file: string): string {
    edits.forEach((edit, index) => {
        if (typeof edit?.oldString !== 'string' || typeof edit?.newString !== 'string' || edit.oldString === '') {
            throw new RemoteFsError('INVALID_REQUEST', `${file}: edit ${index + 1} needs a non-empty oldString and a newString.`);
        }
        if (edit.oldString === edit.newString) {
            throw new RemoteFsError('INVALID_REQUEST', `${file}: edit ${index + 1} does not change anything.`);
        }
        const count = countOccurrences(text, edit.oldString);
        if (count === 0) {
            throw new RemoteFsError('CONFLICT', `${file}: edit ${index + 1}: the text to replace was not found (the file may have changed; read it again).`);
        }
        if (count > 1 && edit.replaceAll !== true) {
            throw new RemoteFsError('CONFLICT', `${file}: edit ${index + 1}: the text to replace matches ${count} places; include more surrounding text or set replaceAll.`);
        }
        text = edit.replaceAll === true
            ? text.split(edit.oldString).join(edit.newString)
            : text.replace(edit.oldString, () => edit.newString);
    });
    return text;
}

export async function applyPatch(request: ApplyPatchRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const files = request?.files;
        if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PATCH_FILES) {
            throw new RemoteFsError('INVALID_REQUEST', `files must list 1 to ${MAX_PATCH_FILES} files.`);
        }

        // 1. Validate everything first; nothing is written if any edit fails.
        const planned = [];
        const seen = new Set<string>();
        for (const file of files) {
            if (!Array.isArray(file?.edits) || file.edits.length === 0 || file.edits.length > MAX_EDITS_PER_FILE) {
                throw new RemoteFsError('INVALID_REQUEST', `Each file needs 1 to ${MAX_EDITS_PER_FILE} edits.`);
            }
            const target = await resolveWriteTarget(file.path, false, request.allowSensitive);
            if (seen.has(target.path)) {
                throw new RemoteFsError('INVALID_REQUEST', `${target.path} is listed twice; put all its edits in one entry.`);
            }
            seen.add(target.path);
            if (!target.existing) {
                throw new RemoteFsError('NOT_FOUND', `${target.path} does not exist; create it with write_file.`);
            }
            checkExpected(target, file.expectedSha256);
            const before = target.existing.content.toString('utf8');
            const after = applyEdits(before, file.edits, target.path);
            planned.push({ target, readSha: sha256(target.existing.content), content: Buffer.from(after, 'utf8'), edits: file.edits.length });
        }

        // 2. Write, re-checking each file immediately before replacing it.
        const written: unknown[] = [];
        for (const plan of planned) {
            try {
                const now = await resolveWriteTarget(plan.target.targetPath, false, request.allowSensitive);
                if (!now.existing || sha256(now.existing.content) !== plan.readSha) {
                    throw new RemoteFsError('CONFLICT', `${plan.target.path} changed while the patch was being applied.`);
                }
                await atomicWrite(now, plan.content);
                written.push({ ...describeWrite(now, plan.content), editsApplied: plan.edits, ...(request.returnContent === true ? reviewContents(now, plan.content) : {}) });
            } catch (error) {
                if (written.length === 0) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new RemoteFsError(error instanceof RemoteFsError ? error.code : 'IO_ERROR',
                    `${message} Already written: ${written.map(w => (w as { path: string }).path).join(', ')}.`);
            }
        }
        return { files: written };
    });
}
