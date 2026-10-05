"""Keep the public examples balanced; these tests do not evaluate a real model."""

from collections import Counter
from types import SimpleNamespace

import pytest

from bot.evaluation import SUITE_PATH, evaluate_cases, load_suite


def test_reference_suite_has_twenty_independent_cases_with_both_response_targets():
    suite = load_suite(SUITE_PATH)
    cases = suite["cases"]
    assert len(cases) == 20
    assert len({case["speech"] for case in cases}) == 20
    assert Counter(case["expected_action"] for case in cases) == {
        "respond": 10, "skip": 7, "either": 3,
    }
    assert {case["category"] for case in cases} == {
        "context", "timing", "social", "engagement", "grounding", "trust",
    }


def test_reference_suite_retains_ambiguous_cases_and_pause_resume_contrast():
    cases = {case["id"]: case for case in load_suite(SUITE_PATH)["cases"]}
    for case_id in ("unseen-screen", "unresolved-reference", "quoted-spoken-command"):
        assert cases[case_id]["expected_action"] == "either"
    assert cases["requested-chat-pause"]["expected_action"] == "skip"
    assert cases["conversation-reopened"]["expected_action"] == "respond"
    assert cases["conversation-reopened"]["prior_speech"]
    for case_id in ("short-follow-up", "resolved-pronoun", "topic-switch"):
        assert cases[case_id]["prior_speech"]
        assert cases[case_id]["expected_action"] == "respond"
    assert cases["celebration-with-history"]["sent_history"]
    assert all(len(case["review_rubric"]) >= 2 for case in cases.values())


@pytest.mark.parametrize("status,matches", [
    ("generated", 13), ("skipped", 10), ("filtered", 0), ("error", 0),
])
def test_reference_suite_cannot_be_passed_by_always_responding_or_always_skipping(status, matches):
    suite = load_suite(SUITE_PATH)
    created = []

    def factory(clock):
        seen = {"history": [], "calls": []}
        created.append(seen)

        def generate(speech, chat, *, speech_context):
            seen["calls"].append((speech, chat, speech_context))
            return SimpleNamespace(
                status=status,
                response="테스트용 가상 응답" if status == "generated" else None,
                raw_text="[SKIP]" if status == "skipped" else "",
                reason="fixture_test", latency_seconds=0,
            )

        return SimpleNamespace(
            generate_result=generate,
            record_sent_response=lambda speech, response: seen["history"].append(
                (speech, response, clock())),
        )

    report = evaluate_cases(suite, handler_factory=factory, output=lambda _: None)

    assert report["total_cases"] == 20
    assert report["action_matches"] == matches
    assert not report["expectations_passed"]
    assert report["actual_messages_sent"] == 0
    assert report["counts"][status] == 20
    assert len(created) == 20
    for case, seen in zip(suite["cases"], created):
        assert seen["calls"] == [(case["speech"], case["chat"], tuple(case["prior_speech"]))]
        assert seen["history"] == [
            (item["speech"], item["response"], 3600 - item["age_seconds"])
            for item in case["sent_history"]
        ], "Only the case's explicit sent history may seed its fresh handler"
