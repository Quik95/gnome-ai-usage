import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Runs `argv` (no shell) with extra environment variables and resolves with its
// stdout. `procs` is the owner's set of live processes, so it can force_exit()
// whatever is still running when it goes away.
export async function run(argv, {env = {}, cancellable = null, procs = null, onSpawn = null} = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    for (const [key, value] of Object.entries(env))
        launcher.setenv(key, value, true);

    const proc = launcher.spawnv(argv);
    procs?.add(proc);
    onSpawn?.(proc);
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return stdout ?? '';
    } finally {
        procs?.delete(proc);
    }
}

export function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}
