import json
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder

from .config import get_request_timeout
from .exceptions import OtterAIException


class OtterAI:
    API_BASE_URL = "https://otter.ai/forward/api/v1/"
    S3_BASE_URL = "https://s3.us-west-2.amazonaws.com/"

    def __init__(self):
        self._session = requests.Session()
        self._userid = None
        self._cookies = None
        self._timeout = get_request_timeout()

    def _is_userid_invalid(self):
        if not self._userid:
            return True
        return False

    def _handle_response(self, response, data=None):
        if data:
            return {"status": response.status_code, "data": data}
        try:
            return {"status": response.status_code, "data": response.json()}
        except ValueError:
            return {"status": response.status_code, "data": {}}

    def _get(self, url, **kwargs):
        kwargs.setdefault("timeout", self._timeout)
        return self._session.get(url, **kwargs)

    def _post(self, url, **kwargs):
        kwargs.setdefault("timeout", self._timeout)
        return self._session.post(url, **kwargs)

    def _coerce_unix_timestamp(self, value, field_name):
        if value is None:
            return None
        if isinstance(value, bool):
            raise OtterAIException(f"{field_name} must be a unix timestamp")

        parsed_value = value
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise OtterAIException(f"{field_name} must be a unix timestamp")
            try:
                parsed_value = float(stripped) if "." in stripped else int(stripped)
            except ValueError as exc:
                raise OtterAIException(
                    f"{field_name} must be a unix timestamp"
                ) from exc

        if not isinstance(parsed_value, (int, float)):
            raise OtterAIException(f"{field_name} must be a unix timestamp")
        if parsed_value < 0:
            raise OtterAIException(f"{field_name} must be >= 0")
        return int(parsed_value)

    def login(self, username, password):
        auth_url = OtterAI.API_BASE_URL + "login"

        payload = {"username": username}

        self._session.auth = (username, password)

        response = self._get(auth_url, params=payload)

        if response.status_code != requests.codes.ok:
            return self._handle_response(response)

        self._userid = response.json()["userid"]
        self._cookies = response.cookies.get_dict()

        return self._handle_response(response)

    def get_user(self):
        user_url = OtterAI.API_BASE_URL + "user"

        response = self._get(user_url)

        return self._handle_response(response)

    def get_speakers(self):
        speakers_url = OtterAI.API_BASE_URL + "speakers"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}

        response = self._get(speakers_url, params=payload)

        return self._handle_response(response)

    def get_speeches(
        self,
        folder=0,
        page_size=45,
        source="owned",
        last_load_ts=None,
        modified_after=None,
        speech_metadata=True,
    ):
        speeches_url = OtterAI.API_BASE_URL + "speeches"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        coerced_last_load_ts = self._coerce_unix_timestamp(last_load_ts, "last_load_ts")
        coerced_modified_after = self._coerce_unix_timestamp(
            modified_after, "modified_after"
        )
        if not isinstance(speech_metadata, bool):
            raise OtterAIException("speech_metadata must be a bool")

        payload = {
            "userid": self._userid,
            "folder": folder,
            "page_size": page_size,
            "source": source,
            "speech_metadata": str(speech_metadata).lower(),
        }
        if coerced_last_load_ts is not None:
            payload["last_load_ts"] = coerced_last_load_ts
        if coerced_modified_after is not None:
            payload["modified_after"] = coerced_modified_after

        response = self._get(speeches_url, params=payload)

        return self._handle_response(response)

    def get_speech(self, speech_id):
        speech_url = OtterAI.API_BASE_URL + "speech"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid, "otid": speech_id}

        response = self._get(speech_url, params=payload)

        return self._handle_response(response)

    def get_abstract_summary(self, speech_id):
        abstract_summary_url = OtterAI.API_BASE_URL + "abstract_summary"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid, "otid": speech_id}

        response = self._get(abstract_summary_url, params=payload)

        return self._handle_response(response)

    def get_speech_action_items(self, speech_id):
        action_items_url = OtterAI.API_BASE_URL + "speech_action_items"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid, "otid": speech_id}

        response = self._get(action_items_url, params=payload)

        return self._handle_response(response)

    def set_speech_title(self, speech_id, title):
        set_title_url = OtterAI.API_BASE_URL + "set_speech_title"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"otid": speech_id, "title": title, "userid": self._userid}

        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", "") if self._cookies else "",
            "referer": "https://otter.ai/",
        }

        response = self._get(set_title_url, params=payload, headers=headers)

        return self._handle_response(response)

    def query_speech(self, query, speech_id, size=500):
        query_speech_url = OtterAI.API_BASE_URL + "advanced_search"

        payload = {"query": query, "size": size, "otid": speech_id}

        response = self._get(query_speech_url, params=payload)

        return self._handle_response(response)

    def upload_speech(self, file_name, content_type="audio/mp4"):
        speech_upload_params_url = OtterAI.API_BASE_URL + "speech_upload_params"
        speech_upload_prod_url = OtterAI.S3_BASE_URL + "speech-upload-prod"
        finish_speech_upload = OtterAI.API_BASE_URL + "finish_speech_upload"

        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}
        response = self._get(speech_upload_params_url, params=payload)

        if response.status_code != requests.codes.ok:
            return self._handle_response(response)

        response_json = response.json()
        params_data = response_json["data"]

        prep_req = requests.Request("OPTIONS", speech_upload_prod_url).prepare()
        prep_req.headers["Accept"] = "*/*"
        prep_req.headers["Connection"] = "keep-alive"
        prep_req.headers["Origin"] = "https://otter.ai"
        prep_req.headers["Referer"] = "https://otter.ai/"
        prep_req.headers["Access-Control-Request-Method"] = "POST"

        response = self._session.send(prep_req, timeout=self._timeout)

        if response.status_code != requests.codes.ok:
            return self._handle_response(response)

        # TODO: test for large files (this should stream)
        fields = {}
        params_data["success_action_status"] = str(params_data["success_action_status"])
        del params_data["form_action"]
        fields.update(params_data)
        fields["file"] = (file_name, open(file_name, mode="rb"), content_type)
        multipart_data = MultipartEncoder(fields=fields)

        response = requests.post(
            speech_upload_prod_url,
            data=multipart_data,
            headers={"Content-Type": multipart_data.content_type},
            timeout=self._timeout,
        )

        if response.status_code != 201:
            return self._handle_response(response)

        xmltree = ET.ElementTree(ET.fromstring(response.text))
        xmlroot = xmltree.getroot()
        # TODO: clean this up
        location = xmlroot[0].text
        bucket = xmlroot[1].text
        key = xmlroot[2].text

        payload = {
            "bucket": bucket,
            "key": key,
            "language": "en",
            "country": "us",
            "userid": self._userid,
        }
        response = self._get(finish_speech_upload, params=payload)

        return self._handle_response(response)

    def download_speech(self, speech_id, name=None, fileformat="txt,pdf,mp3,docx,srt"):
        download_speech_url = OtterAI.API_BASE_URL + "bulk_export"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        base_name = str(name if name is not None else speech_id)
        safe_base_name = Path(base_name).name
        if safe_base_name in {"", ".", ".."}:
            raise OtterAIException("invalid output filename")

        payload = {"userid": self._userid}

        data = {"formats": fileformat, "speech_otid_list": [speech_id]}
        headers = {
            "x-csrftoken": self._cookies["csrftoken"],
            "referer": "https://otter.ai/",
        }
        response = self._post(
            download_speech_url, params=payload, headers=headers, data=data
        )

        filename = safe_base_name + "." + ("zip" if "," in fileformat else fileformat)
        if response.ok:
            with open(filename, "wb") as f:
                f.write(response.content)
        else:
            raise OtterAIException(
                f"Got response status {response.status_code} when attempting to download {speech_id}"
            )
        return self._handle_response(response, data={"filename": filename})

    def move_to_trash_bin(self, speech_id):
        move_to_trash_bin_url = OtterAI.API_BASE_URL + "move_to_trash_bin"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}

        data = {"otid": speech_id}
        headers = {
            "x-csrftoken": self._cookies["csrftoken"],
            "referer": "https://otter.ai/",
        }
        response = self._post(
            move_to_trash_bin_url, params=payload, headers=headers, data=data
        )

        return self._handle_response(response)

    def create_speaker(self, speaker_name):
        create_speaker_url = OtterAI.API_BASE_URL + "create_speaker"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}

        data = {"speaker_name": speaker_name}
        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", ""),
            "referer": "https://otter.ai/",
        }
        response = self._post(
            create_speaker_url, params=payload, headers=headers, data=data
        )

        return self._handle_response(response)

    def set_transcript_speaker(
        self, speech_id, transcript_uuid, speaker_id, speaker_name, create_speaker=False
    ):
        """Tag a speaker on a specific transcript segment.

        Args:
            speech_id: The speech/conversation otid
            transcript_uuid: UUID of the specific transcript segment
            speaker_id: ID of existing speaker (from get_speakers)
            speaker_name: Name of the speaker
            create_speaker: If True, create new speaker if not exists

        Returns:
            Response dict with status and data
        """
        set_speaker_url = OtterAI.API_BASE_URL + "set_transcript_speaker"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {
            "speech_otid": speech_id,
            "transcript_uuid": transcript_uuid,
            "speaker_name": speaker_name,
            "userid": self._userid,
            "create_speaker": str(create_speaker).lower(),
            "speaker_id": speaker_id,
        }

        headers = {
            "referer": "https://otter.ai/",
            "x-csrftoken": self._cookies.get("csrftoken", ""),
        }
        response = self._get(set_speaker_url, params=payload, headers=headers)

        return self._handle_response(response)

    def get_notification_settings(self):
        notification_settings_url = OtterAI.API_BASE_URL + "get_notification_settings"
        response = self._get(notification_settings_url)

        return self._handle_response(response)

    def list_groups(self):
        list_groups_url = OtterAI.API_BASE_URL + "list_groups"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}

        response = self._get(list_groups_url, params=payload)

        return self._handle_response(response)

    def get_folders(self):
        folders_url = OtterAI.API_BASE_URL + "folders"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}

        response = self._get(folders_url, params=payload)

        return self._handle_response(response)

    def create_folder(self, folder_name):
        """Create a new folder.

        Args:
            folder_name: Name for the new folder

        Returns:
            Response dict with status and data including new folder ID
        """
        create_folder_url = OtterAI.API_BASE_URL + "create_folder"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid}
        data = {"folder_name": folder_name}
        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", ""),
            "referer": "https://otter.ai/",
        }
        response = self._post(
            create_folder_url, params=payload, headers=headers, data=data
        )

        return self._handle_response(response)

    def rename_folder(self, folder_id, new_name):
        """Rename an existing folder.

        Args:
            folder_id: ID of the folder to rename
            new_name: New name for the folder

        Returns:
            Response dict with status and data
        """
        rename_folder_url = OtterAI.API_BASE_URL + "rename_folder"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        payload = {"userid": self._userid, "folder_id": folder_id}
        data = {"new_name": new_name}
        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", ""),
            "referer": "https://otter.ai/",
        }
        response = self._post(
            rename_folder_url, params=payload, headers=headers, data=data
        )

        return self._handle_response(response)

    def add_folder_speeches(self, folder_id, speech_ids):
        """Move speeches to a folder.

        Args:
            folder_id: ID of the destination folder
            speech_ids: Single speech ID string or list of speech IDs

        Returns:
            Response dict with status and data
        """
        add_folder_speeches_url = OtterAI.API_BASE_URL + "add_folder_speeches"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        # Handle both single ID and list
        if isinstance(speech_ids, str):
            speech_ids = [speech_ids]

        payload = {"userid": self._userid, "folder_id": folder_id}
        data = {"speech_otid_list": speech_ids}
        headers = {
            "x-csrftoken": self._cookies.get("csrftoken", ""),
            "referer": "https://otter.ai/",
        }
        response = self._post(
            add_folder_speeches_url, params=payload, headers=headers, data=data
        )

        return self._handle_response(response)

    def list_folder_speeches(
        self, folder_id, page_size=12, last_load_speech_id=None, speech_metadata=True
    ):
        """Fetch speeches from a single folder with optional pagination."""
        list_folder_speeches_url = OtterAI.API_BASE_URL + "list_folder_speeches"
        if self._is_userid_invalid():
            raise OtterAIException("userid is invalid")

        if isinstance(folder_id, bool) or folder_id is None:
            raise OtterAIException("folder_id must be a non-empty string or int")
        if isinstance(folder_id, str):
            folder_id = folder_id.strip()
            if not folder_id:
                raise OtterAIException("folder_id must be a non-empty string or int")
        elif isinstance(folder_id, int):
            if folder_id < 0:
                raise OtterAIException("folder_id must be >= 0")
        else:
            raise OtterAIException("folder_id must be a non-empty string or int")

        if (
            isinstance(page_size, bool)
            or not isinstance(page_size, int)
            or page_size < 1
        ):
            raise OtterAIException("page_size must be an integer >= 1")

        if not isinstance(speech_metadata, bool):
            raise OtterAIException("speech_metadata must be a bool")

        payload = {
            "userid": self._userid,
            "folder_id": folder_id,
            "page_size": page_size,
            "speech_metadata": str(speech_metadata).lower(),
        }
        if last_load_speech_id is not None:
            if (
                not isinstance(last_load_speech_id, str)
                or not last_load_speech_id.strip()
            ):
                raise OtterAIException("last_load_speech_id must be a non-empty string")
            payload["last_load_speech_id"] = last_load_speech_id.strip()

        response = self._get(list_folder_speeches_url, params=payload)
        return self._handle_response(response)

    def speech_start(self):
        speech_start_url = OtterAI.API_BASE_URL + "speech_start"
        ### TODO
        # In the browser a websocket session is opened
        # wss://ws.aisense.com/api/v2/client/speech?token=ey...
        # The speech_start endpoint returns the JWT token

    def stop_speech(self):
        speech_finish_url = OtterAI.API_BASE_URL + "speech_finish"
