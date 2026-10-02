"""Compatible entry point; help, setup and diagnostics do not load devices."""


def main(argv=None):
    from bot.cli import main as cli_main
    return cli_main(argv)


def __getattr__(name):
    if name == "ChzzkVoiceBot":
        from bot.runtime import ChzzkVoiceBot
        return ChzzkVoiceBot
    # Legacy callers may use these shared lightweight objects for configuration.
    if name == "Config":
        from config import Config
        return Config
    if name == "time":
        import time
        return time
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    raise SystemExit(main())
