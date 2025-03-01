import { promises as fs, unlinkSync, rmdirSync } from 'fs';
import os from 'os';
import { dirname } from 'path';

import { exec } from './fs-utils';

// Equivalent to `drwxrwxrwt`
const STICKY_WRITE_PERMISSIONS = 0o1777;

/**
 * Internal lockfile manager to track files in memory
 */
// Track locksTaken, so that the proper locks can be cleaned up on process exit
const locksTaken: { [lockName: string]: boolean } = {};

// Returns all current locks taken, as they've been stored in-memory.
// Optionally accepts filter function for only getting locks that match a condition.
export const getLocksTaken = (
	lockFilter: (path: string) => boolean = () => true,
): string[] => Object.keys(locksTaken).filter(lockFilter);

// Try to clean up any existing locks when the process exits
process.on('exit', () => {
	for (const lockName of getLocksTaken()) {
		try {
			unlockSync(lockName);
		} catch (e) {
			// Ignore unlocking errors
		}
	}
});

interface ChildProcessError {
	code: number;
	stderr: string;
	stdout: string;
}

export class LockfileExistsError implements ChildProcessError {
	public code: number;
	public stderr: string;
	public stdout: string;

	constructor(path: string) {
		this.code = 73;
		this.stderr = `lockfile: Sorry, giving up on "${path}"`;
		this.stdout = '';
	}

	// Check if an error is an instance of LockfileExistsError.
	// This is necessary because the error thrown is a child process
	// error that isn't typed by default, so instanceof will not work.
	public static is(error: unknown): error is LockfileExistsError {
		return (error as LockfileExistsError).code === 73;
	}
}

export async function lock(path: string, uid: number = os.userInfo().uid) {
	/**
	 * Set parent directory permissions to `drwxrwxrwt` (octal 1777), which are needed
	 * for lockfile binary to run successfully as the any non-root uid, if executing
	 * this command as a privileged uid.
	 * NOTE: This will change the permissions of the parent directory at `path`,
	 * which may not be expected if using lockfile as an independent module.
	 *
	 * `chmod` does not fail or throw if the directory already has the proper permissions.
	 */
	if (uid !== 0) {
		await fs.chmod(dirname(path), STICKY_WRITE_PERMISSIONS);
	}

	/**
	 * Run the lockfile binary as the provided UID. See https://linux.die.net/man/1/lockfile
	 * `-r 0` means that lockfile will not retry if the lock exists.
	 * If `uid` is not privileged or does not have write permissions to the path, this command will not succeed.
	 */
	try {
		// Lock the file using binary
		await exec(`lockfile -r 0 ${path}`, { uid });
		// Store a lock in memory as taken
		locksTaken[path] = true;
	} catch (error) {
		// Code 73 refers to EX_CANTCREAT (73) in sysexits.h, or:
		// A (user specified) output file cannot be created.
		// See: https://nxmnpg.lemoda.net/3/sysexits
		if (LockfileExistsError.is(error)) {
			// If error code is 73, updates.lock file already exists, so throw this error directly
			throw error;
		} else {
			/**
			 * For the most part, a child process error with code 73 should be thrown,
			 * indicating the lockfile already exists. Any other error's child process
			 * code should be included in the error message to more clearly signal
			 * what went wrong. Other errors that are not the typical "file exists"
			 * errors include but aren't limited to:
			 *   - running out of file descriptors
			 *   - binary corruption
			 *   - other systems-based errors
			 */
			throw new Error(
				`Got code ${
					(error as ChildProcessError).code
				} while trying to take lock: ${(error as ChildProcessError).stderr}`,
			);
		}
	}
}

export async function unlock(path: string): Promise<void> {
	// Removing the lockfile releases the lock
	await fs.unlink(path).catch((e) => {
		// if the error is EPERM|EISDIR, the file is a directory
		if (e.code === 'EPERM' || e.code === 'EISDIR') {
			return fs.rmdir(path).catch(() => {
				// if the directory is not empty or something else
				// happens, ignore
			});
		}
		// If the file does not exist or some other error
		// happens, then ignore the error
	});
	// Remove lockfile's in-memory tracking of a file
	delete locksTaken[path];
}

export function unlockSync(path: string) {
	try {
		return unlinkSync(path);
	} catch (e: any) {
		if (e.code === 'EPERM' || e.code === 'EISDIR') {
			return rmdirSync(path);
		}
		throw e;
	}
}
