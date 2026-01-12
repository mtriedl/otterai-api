"""
Command-line interface for OtterAI.

Usage:
    otter login
    otter speeches list
    otter speeches download <speech_id>
    otter speakers list
"""

import json
import sys

import click

from .config import clear_credentials, get_config_path, load_credentials, save_credentials
from .otterai import OtterAI, OtterAIException


def get_authenticated_client() -> OtterAI:
    """Get an authenticated OtterAI client."""
    username, password = load_credentials()
    if not username or not password:
        click.echo("Not logged in. Run 'otter login' first.", err=True)
        sys.exit(1)

    client = OtterAI()
    result = client.login(username, password)
    if result["status"] != 200:
        click.echo(f"Login failed: {result}", err=True)
        sys.exit(1)

    return client


@click.group()
@click.version_option(version="0.1.0", prog_name="otter")
def main():
    """OtterAI CLI - Interact with Otter.ai from the command line."""
    pass


# =============================================================================
# Authentication Commands
# =============================================================================


@main.command()
@click.option("--username", "-u", prompt=True, help="Otter.ai username (email)")
@click.option(
    "--password", "-p", prompt=True, hide_input=True, help="Otter.ai password"
)
def login(username: str, password: str):
    """Authenticate with Otter.ai and save credentials."""
    client = OtterAI()
    result = client.login(username, password)

    if result["status"] != 200:
        click.echo(f"Login failed: {result.get('data', {})}", err=True)
        sys.exit(1)

    save_credentials(username, password)
    user_data = result.get("data", {})
    click.echo(f"Logged in as {user_data.get('email', username)}")
    click.echo(f"Credentials saved to {get_config_path()}")


@main.command()
def logout():
    """Clear saved credentials."""
    if clear_credentials():
        click.echo("Credentials cleared.")
    else:
        click.echo("No saved credentials found.")


@main.command()
def user():
    """Show current user information."""
    client = get_authenticated_client()
    result = client.get_user()

    if result["status"] != 200:
        click.echo(f"Failed to get user: {result}", err=True)
        sys.exit(1)

    click.echo(json.dumps(result["data"], indent=2))


# =============================================================================
# Speeches Commands
# =============================================================================


@main.group()
def speeches():
    """Manage speeches (transcripts)."""
    pass


@speeches.command("list")
@click.option("--folder", "-f", default=0, help="Folder ID (default: 0)")
@click.option("--page-size", "-n", default=45, help="Number of results (default: 45)")
@click.option(
    "--source",
    "-s",
    default="owned",
    type=click.Choice(["owned", "shared", "all"]),
    help="Source filter (default: owned)",
)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def speeches_list(folder: int, page_size: int, source: str, as_json: bool):
    """List all speeches."""
    client = get_authenticated_client()

    try:
        result = client.get_speeches(folder=folder, page_size=page_size, source=source)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to get speeches: {result}", err=True)
        sys.exit(1)

    data = result["data"]

    if as_json:
        click.echo(json.dumps(data, indent=2))
        return

    speeches_data = data.get("speeches", [])
    if not speeches_data:
        click.echo("No speeches found.")
        return

    click.echo(f"Found {len(speeches_data)} speeches:\n")
    for speech in speeches_data:
        title = speech.get("title", "Untitled")
        otid = speech.get("otid", "")
        created = speech.get("created_at", "")
        click.echo(f"  {otid}  {title}")
        if created:
            click.echo(f"           Created: {created}")
        click.echo()


@speeches.command("get")
@click.argument("speech_id")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def speeches_get(speech_id: str, as_json: bool):
    """Get details of a specific speech."""
    client = get_authenticated_client()

    try:
        result = client.get_speech(speech_id)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to get speech: {result}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(result["data"], indent=2))
        return

    data = result["data"]
    speech = data.get("speech", {})
    click.echo(f"Title: {speech.get('title', 'Untitled')}")
    click.echo(f"ID: {speech.get('otid', '')}")
    click.echo(f"Created: {speech.get('created_at', '')}")
    click.echo(f"Duration: {speech.get('duration', 0)} seconds")

    # Print transcript if available
    transcripts = data.get("transcripts", [])
    if transcripts:
        click.echo("\nTranscript:")
        click.echo("-" * 40)
        for t in transcripts:
            speaker = t.get("speaker_name", "Unknown")
            text = t.get("transcript", "")
            click.echo(f"[{speaker}]: {text}")


@speeches.command("search")
@click.argument("query")
@click.argument("speech_id")
@click.option("--size", "-n", default=500, help="Max results (default: 500)")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def speeches_search(query: str, speech_id: str, size: int, as_json: bool):
    """Search within a speech transcript."""
    client = get_authenticated_client()

    try:
        result = client.query_speech(query, speech_id, size=size)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Search failed: {result}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(result["data"], indent=2))
    else:
        click.echo(json.dumps(result["data"], indent=2))


@speeches.command("rename")
@click.argument("speech_id")
@click.argument("title")
def speeches_rename(speech_id: str, title: str):
    """Rename a speech (set new title)."""
    client = get_authenticated_client()

    try:
        result = client.set_speech_title(speech_id, title)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Rename failed: {result}", err=True)
        sys.exit(1)

    click.echo(f"Renamed speech {speech_id} to: {title}")


@speeches.command("download")
@click.argument("speech_id")
@click.option(
    "--format",
    "-f",
    "fileformat",
    default="txt",
    help="Format(s): txt, pdf, mp3, docx, srt (comma-separated, default: txt)",
)
@click.option("--output", "-o", "name", default=None, help="Output filename (optional)")
def speeches_download(speech_id: str, fileformat: str, name: str):
    """Download a speech in specified format(s)."""
    client = get_authenticated_client()

    try:
        result = client.download_speech(speech_id, name=name, fileformat=fileformat)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Download failed: {result}", err=True)
        sys.exit(1)

    filename = result["data"].get("filename", "")
    click.echo(f"Downloaded: {filename}")


@speeches.command("upload")
@click.argument("file", type=click.Path(exists=True))
@click.option(
    "--content-type",
    "-t",
    default="audio/mp4",
    help="MIME type (default: audio/mp4)",
)
def speeches_upload(file: str, content_type: str):
    """Upload an audio file for transcription."""
    client = get_authenticated_client()

    click.echo(f"Uploading {file}...")

    try:
        result = client.upload_speech(file, content_type=content_type)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Upload failed: {result}", err=True)
        sys.exit(1)

    click.echo("Upload successful! Transcription is processing.")
    click.echo(json.dumps(result["data"], indent=2))


@speeches.command("trash")
@click.argument("speech_id")
@click.option("--yes", "-y", is_flag=True, help="Skip confirmation")
def speeches_trash(speech_id: str, yes: bool):
    """Move a speech to trash."""
    if not yes:
        click.confirm(f"Move speech {speech_id} to trash?", abort=True)

    client = get_authenticated_client()

    try:
        result = client.move_to_trash_bin(speech_id)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to trash speech: {result}", err=True)
        sys.exit(1)

    click.echo(f"Speech {speech_id} moved to trash.")


# =============================================================================
# Speakers Commands
# =============================================================================


@main.group()
def speakers():
    """Manage speakers."""
    pass


@speakers.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def speakers_list(as_json: bool):
    """List all speakers."""
    client = get_authenticated_client()

    try:
        result = client.get_speakers()
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to get speakers: {result}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(result["data"], indent=2))
        return

    speakers_data = result["data"].get("speakers", [])
    if not speakers_data:
        click.echo("No speakers found.")
        return

    click.echo(f"Found {len(speakers_data)} speakers:\n")
    for speaker in speakers_data:
        name = speaker.get("speaker_name", "Unknown")
        speaker_id = speaker.get("speaker_id", "")
        click.echo(f"  {speaker_id}  {name}")


@speakers.command("create")
@click.argument("name")
def speakers_create(name: str):
    """Create a new speaker."""
    client = get_authenticated_client()

    try:
        result = client.create_speaker(name)
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to create speaker: {result}", err=True)
        sys.exit(1)

    click.echo(f"Speaker '{name}' created.")
    click.echo(json.dumps(result["data"], indent=2))


# =============================================================================
# Folders Commands
# =============================================================================


@main.group()
def folders():
    """Manage folders."""
    pass


@folders.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def folders_list(as_json: bool):
    """List all folders."""
    client = get_authenticated_client()

    try:
        result = client.get_folders()
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to get folders: {result}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(result["data"], indent=2))
    else:
        click.echo(json.dumps(result["data"], indent=2))


# =============================================================================
# Groups Commands
# =============================================================================


@main.group()
def groups():
    """Manage groups."""
    pass


@groups.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def groups_list(as_json: bool):
    """List all groups."""
    client = get_authenticated_client()

    try:
        result = client.list_groups()
    except OtterAIException as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if result["status"] != 200:
        click.echo(f"Failed to get groups: {result}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(result["data"], indent=2))
    else:
        click.echo(json.dumps(result["data"], indent=2))


# =============================================================================
# Config Commands
# =============================================================================


@main.group()
def config():
    """Manage CLI configuration."""
    pass


@config.command("show")
def config_show():
    """Show current configuration."""
    username, password = load_credentials()
    config_path = get_config_path()

    click.echo(f"Config file: {config_path}")
    click.echo(f"Config exists: {config_path.exists()}")

    if username:
        click.echo(f"Username: {username}")
        click.echo(f"Password: {'*' * len(password) if password else 'Not set'}")
    else:
        click.echo("Not logged in.")


@config.command("clear")
def config_clear():
    """Clear saved configuration."""
    if clear_credentials():
        click.echo("Configuration cleared.")
    else:
        click.echo("No configuration found.")


if __name__ == "__main__":
    main()
