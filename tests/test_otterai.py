import os
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from dotenv import load_dotenv

from otterai.otterai import OtterAI, OtterAIException
from tests.helpers import dump_json_response

load_dotenv()


@pytest.fixture
def logged_in_otter():
    username = os.getenv("OTTERAI_USERNAME")
    password = os.getenv("OTTERAI_PASSWORD")
    otter = OtterAI()
    otter.login(username, password)
    return otter


def test_dump_json_dummy():
    dummy_response = {"foo": "bar", "baz": [1, 2, 3]}
    dump_json_response(dummy_response, "dummy.json")


def test_otterai_instantiation():
    otter = OtterAI()
    assert otter._userid is None
    assert otter._is_userid_invalid() is True


def test_is_userid_invalid_true():
    otter = OtterAI()
    assert otter._is_userid_invalid() is True


def test_otterai_valid_userid():
    otter = OtterAI()
    otter._userid = "validid"
    assert otter._is_userid_invalid() is False


def test_login(logged_in_otter):
    assert logged_in_otter._userid is not None


def test_get_user(logged_in_otter):
    username = os.getenv("OTTERAI_USERNAME")
    response = logged_in_otter.get_user()
    assert response["data"]["user"]["email"] == username


def test_get_speakers(logged_in_otter):
    response = logged_in_otter.get_speakers()
    assert response["status"] == 200


def test_get_speakers_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.get_speakers()


def test_get_speeches(logged_in_otter):
    response = logged_in_otter.get_speeches()
    assert response["status"] == 200


def test_get_speeches_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.get_speeches()


def test_get_speech_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.get_speech("dummyid")


def test_query_speech(logged_in_otter):
    # Minimal test, can be expanded
    response = logged_in_otter.query_speech("test", "dummyid")
    assert "status" in response


def test_upload_speech_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.upload_speech("dummy.mp4")


def test_download_speech_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.download_speech("dummyid")


def test_move_to_trash_bin_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.move_to_trash_bin("dummyid")


def test_create_speaker_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.create_speaker("dummy_speaker")


def test_get_notification_settings(logged_in_otter):
    response = logged_in_otter.get_notification_settings()
    assert "status" in response


def test_list_groups_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.list_groups()


def test_get_folders_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.get_folders()


def test_stop_speech():
    otter = OtterAI()
    otter.stop_speech()


def test_set_speech_title_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.set_speech_title("dummyid", "New Title")


def test_set_speech_title_includes_userid_and_auth_headers():
    otter = OtterAI()
    otter._userid = "user123"
    otter._cookies = {"csrftoken": "csrf-token"}

    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {}
    otter._session = MagicMock()
    otter._session.get.return_value = response

    otter.set_speech_title("speech123", "New Title")

    otter._session.get.assert_called_once_with(
        OtterAI.API_BASE_URL + "set_speech_title",
        params={"otid": "speech123", "title": "New Title", "userid": "user123"},
        headers={"x-csrftoken": "csrf-token", "referer": "https://otter.ai/"},
        timeout=otter._timeout,
    )


def test_otterai_uses_timeout_from_config():
    with patch("otterai.otterai.get_request_timeout", return_value=9.5):
        otter = OtterAI()
    assert otter._timeout == 9.5


def test_login_uses_timeout():
    otter = OtterAI()
    otter._timeout = 11.0

    response = MagicMock()
    response.status_code = 401
    response.json.return_value = {}
    otter._session = MagicMock()
    otter._session.get.return_value = response

    otter.login("test@example.com", "pass")

    otter._session.get.assert_called_once_with(
        OtterAI.API_BASE_URL + "login",
        params={"username": "test@example.com"},
        timeout=11.0,
    )


def test_download_speech_sanitizes_filename_and_uses_timeout(tmp_path, monkeypatch):
    otter = OtterAI()
    otter._userid = "user123"
    otter._cookies = {"csrftoken": "csrf-token"}
    otter._timeout = 17.0

    response = MagicMock()
    response.status_code = 200
    response.ok = True
    response.content = b"dummy-bytes"
    otter._session = MagicMock()
    otter._session.post.return_value = response

    monkeypatch.chdir(tmp_path)
    result = otter.download_speech("speech123", name="../evil", fileformat="txt")

    assert result["data"]["filename"] == "evil.txt"
    assert (tmp_path / "evil.txt").exists()
    otter._session.post.assert_called_once_with(
        OtterAI.API_BASE_URL + "bulk_export",
        params={"userid": "user123"},
        headers={"x-csrftoken": "csrf-token", "referer": "https://otter.ai/"},
        data={"formats": "txt", "speech_otid_list": ["speech123"]},
        timeout=17.0,
    )


@pytest.mark.parametrize("invalid_name", ["", ".", "..", "../"])
def test_download_speech_rejects_invalid_output_names(invalid_name):
    otter = OtterAI()
    otter._userid = "user123"
    otter._cookies = {"csrftoken": "csrf-token"}

    with pytest.raises(OtterAIException, match="invalid output filename"):
        otter.download_speech("speech123", name=invalid_name, fileformat="txt")


def test_set_transcript_speaker_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.set_transcript_speaker("dummyid", "dummy_uuid", "speaker1", "John Doe")


def test_create_folder_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.create_folder("Test Folder")


def test_rename_folder_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.rename_folder("folder123", "New Name")


def test_add_folder_speeches_invalid_userid():
    otter = OtterAI()
    with pytest.raises(OtterAIException, match="userid is invalid"):
        otter.add_folder_speeches("folder123", ["speech1", "speech2"])
