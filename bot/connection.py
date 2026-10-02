"""Small asyncio lifecycle helpers shared by the reader and sender.

The owning worker is responsible for closing its client and event loop. Other
threads only cancel its active connection task, so shutdown never attempts to
run the same loop from two threads.
"""
import asyncio


def is_authentication_error(error):
    """Recognize explicit library/HTTP auth failures without exposing their text."""
    return (type(error).__name__ in {"LoginRequired", "UnauthorizedException"}
            or getattr(error, "status", None) == 401
            or getattr(error, "status_code", None) == 401
            # chzzkpy's HTTPException stores its code only in this suffix.
            or (type(error).__name__ == "HTTPException" and str(error).endswith("(401)")))


def cancel_connection(loop, task):
    """Interrupt a connection without blocking the caller or creating a coroutine."""
    if loop is None or task is None or loop.is_closed():
        return
    try:
        def interrupt():
            if not task.done():
                task.cancel()
                # Some clients close their socket in start()'s finally block.
                # A second cancellation also bounds a stalled cleanup there.
                loop.call_later(3.0, task.cancel)

        loop.call_soon_threadsafe(interrupt)
    except RuntimeError:
        # The owning worker may have closed the loop after the snapshot.
        pass


def close_client(loop, client, timeout=3.0):
    """Close on the owning thread, with a bounded wait even on a broken socket."""
    if client is None or loop.is_running() or loop.is_closed():
        return
    try:
        async def close():
            task = asyncio.create_task(client.close())
            done, _ = await asyncio.wait({task}, timeout=timeout)
            if not done:
                task.cancel()
            else:
                task.result()

        loop.run_until_complete(close())
    except (Exception, asyncio.CancelledError):
        pass


def close_loop(loop):
    """Cancel abandoned socket/send tasks before disposing of their event loop."""
    if loop.is_closed() or loop.is_running():
        return
    pending = asyncio.all_tasks(loop)
    for task in pending:
        task.cancel()
    if pending:
        async def drain():
            await asyncio.wait(pending, timeout=1.0)

        try:
            loop.run_until_complete(drain())
        except (Exception, asyncio.CancelledError):
            pass
    loop.close()
