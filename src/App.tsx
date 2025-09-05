import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import QRCode from "react-qr-code";

// ===================== 유틸 =====================
function uuid() {
  return (
    (window.crypto as any)?.randomUUID?.() ||
    `id-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}
function getViewMode() {
  return window.location.hash === "#student" ? "student" : "admin";
}

// ===================== 메인 앱 =====================
export default function App() {
  const [viewMode, setViewMode] = useState<"admin" | "student">(getViewMode());
  useEffect(() => {
    const onHash = () => setViewMode(getViewMode());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ------- 공통 상태 -------
  const [title, setTitle] = useState("우리 반 결정 투표");
  const [desc, setDesc] = useState("설명을 입력하세요. 예) 체험학습 장소를 골라요!");
  const [voteLimit, setVoteLimit] = useState<1 | 2>(1);
  const [options, setOptions] = useState<Array<{ id: string; label: string; votes: number }>>([
    { id: uuid(), label: "보기 1", votes: 0 },
    { id: uuid(), label: "보기 2", votes: 0 },
  ]);

  // key(투표자 식별) -> { ids, at, name? }
  const [ballots, setBallots] = useState<
    Record<string, { ids: string[]; at: number; name?: string }>
  >({});

  // 공개/익명/마감
  const [anonymous, setAnonymous] = useState(false);
  const [visibilityMode, setVisibilityMode] =
    useState<"always" | "hidden" | "deadline">("always");
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);

  // 투표 인원 자동 마감
  const [expectedVoters, setExpectedVoters] = useState<number>(0); // 0=미설정
  const [manualClosed, setManualClosed] = useState(false);

  // 학생 입력
  const [voterName, setVoterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const [saveHint, setSaveHint] = useState("");

  const STORAGE_KEY = "classroom_vote_v3";

  // ------- 로컬 저장/로드 -------
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.title) setTitle(data.title);
      if (data.desc) setDesc(data.desc);
      if (data.voteLimit) setVoteLimit(data.voteLimit);
      if (Array.isArray(data.options)) setOptions(data.options);
      if (data.ballots) setBallots(data.ballots);
      if (typeof data.anonymous === "boolean") setAnonymous(data.anonymous);
      if (data.visibilityMode) setVisibilityMode(data.visibilityMode);
      if (data.deadlineAt ?? null) setDeadlineAt(data.deadlineAt);
      if (typeof data.expectedVoters === "number") setExpectedVoters(data.expectedVoters);
      if (typeof data.manualClosed === "boolean") setManualClosed(data.manualClosed);
    } catch (e) {
      console.warn("로컬 데이터 불러오기 실패", e);
    }
  }, []);

  useEffect(() => {
    const payload = JSON.stringify(
      {
        title,
        desc,
        voteLimit,
        options,
        ballots,
        anonymous,
        visibilityMode,
        deadlineAt,
        expectedVoters,
        manualClosed,
      },
      null,
      0
    );
    localStorage.setItem(STORAGE_KEY, payload);
  }, [
    title,
    desc,
    voteLimit,
    options,
    ballots,
    anonymous,
    visibilityMode,
    deadlineAt,
    expectedVoters,
    manualClosed,
  ]);

  // ------- 파생값 -------
  const totalVotes = useMemo(
    () => options.reduce((sum, o) => sum + o.votes, 0),
    [options]
  );
  const votedCount = useMemo(() => Object.keys(ballots).length, [ballots]);
  const autoClosed = useMemo(
    () => expectedVoters > 0 && votedCount >= expectedVoters,
    [expectedVoters, votedCount]
  );
  const isClosed = manualClosed || autoClosed;

  const graphData = useMemo(
    () => options.map((o) => ({ name: o.label, votes: o.votes })),
    [options]
  );

  const now = Date.now();
  const isVisible = useMemo(() => {
    if (visibilityMode === "always") return true;
    if (visibilityMode === "hidden") return false;
    if (!deadlineAt) return false;
    return now >= deadlineAt;
  }, [visibilityMode, deadlineAt, now]);

  // ------- 옵션 편집 -------
  function setOptionLabel(id: string, label: string) {
    setOptions((prev) => prev.map((o) => (o.id === id ? { ...o, label } : o)));
  }
  function addOption() {
    const label = `보기 ${options.length + 1}`;
    setOptions((prev) => [...prev, { id: uuid(), label, votes: 0 }]);
  }
  function removeOption(id: string) {
    setOptions((prev) => prev.filter((o) => o.id !== id));
    setBallots((prev) => {
      const next: typeof prev = {};
      Object.entries(prev).forEach(([k, info]) => {
        next[k] = { ...info, ids: info.ids.filter((x) => x !== id) };
      });
      // 표수 재계산
      setTimeout(recountVotes, 0);
      return next;
    });
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= voteLimit) return prev;
      return [...prev, id];
    });
  }
  function recountVotes() {
    setOptions((prev) => {
      const zeroed = prev.map((o) => ({ ...o, votes: 0 }));
      const countMap: Record<string, number> = {};
      Object.values(ballots).forEach(({ ids }) =>
        ids.forEach((id) => (countMap[id] = (countMap[id] || 0) + 1))
      );
      return zeroed.map((o) => ({ ...o, votes: countMap[o.id] || 0 }));
    });
  }

  // ------- 투표 제출 -------
  function getStudentKey() {
    if (anonymous) {
      let token = localStorage.getItem("vote_device_token");
      if (!token) {
        token = uuid();
        localStorage.setItem("vote_device_token", token);
      }
      return token;
    }
    return voterName.trim();
  }
  function submitVote() {
    if (isClosed) return alert("투표가 마감되었습니다.");
    const key = getStudentKey();
    if (!key) return alert("이름/번호를 입력하세요.");
    if (selected.length === 0) return alert("선택한 보기가 없습니다.");
    if (ballots[key]) return alert("이미 투표했습니다.");

    const nowMs = Date.now();
    setBallots((prev) => ({
      ...prev,
      [key]: { ids: selected, at: nowMs, name: anonymous ? undefined : voterName.trim() },
    }));
    setOptions((prev) =>
      prev.map((o) => ({ ...o, votes: o.votes + (selected.includes(o.id) ? 1 : 0) }))
    );
    setVoterName("");
    setSelected([]);
  }

  // ------- 관리자 제어 -------
  function clearAll() {
    if (!confirm("모든 결과를 초기화할까요? (되돌릴 수 없음)")) return;
    setBallots({});
    setOptions((prev) => prev.map((o) => ({ ...o, votes: 0 })));
    setSelected([]);
    setManualClosed(false);
  }
  function closeNow() {
    setManualClosed(true);
  }
  function reopen() {
    setManualClosed(false);
  }

  // ------- 저장/불러오기 -------
  function download(filename: string, text: string, mime = "application/json") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function saveJSON() {
    const payload = JSON.stringify(
      {
        title,
        desc,
        voteLimit,
        options,
        ballots,
        anonymous,
        visibilityMode,
        deadlineAt,
        expectedVoters,
        manualClosed,
      },
      null,
      2
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-result-${stamp}.json`, payload, "application/json");
    setSaveHint("JSON으로 저장했어요.");
  }
  function saveCSV() {
    const head = "option,votes\n";
    const rows = options.map((o) => `${escapeCSV(o.label)},${o.votes}`).join("\n");
    const csv = head + rows;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-summary-${stamp}.csv`, csv, "text/csv");
    setSaveHint("CSV 요약을 저장했어요.");
  }
  function escapeCSV(s: string) {
    if (s == null) return "";
    const needs = /[",\n]/.test(s);
    const out = String(s).replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  }

  // ------- 링크/QR -------
  const studentLink = useMemo(() => {
    const url = new URL(window.location.href);
    url.hash = "#student";
    return url.toString();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  function loadFromFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(String(ev.target?.result || "{}"));
        if (data.title) setTitle(data.title);
        if (data.desc) setDesc(data.desc);
        if (data.voteLimit) setVoteLimit(data.voteLimit);
        if (Array.isArray(data.options)) setOptions(data.options);
        if (data.ballots) setBallots(data.ballots);
        if (typeof data.anonymous === "boolean") setAnonymous(data.anonymous);
        if (data.visibilityMode) setVisibilityMode(data.visibilityMode);
        if (data.deadlineAt ?? null) setDeadlineAt(data.deadlineAt);
        if (typeof data.expectedVoters === "number") setExpectedVoters(data.expectedVoters);
        if (typeof data.manualClosed === "boolean") setManualClosed(data.manualClosed);
        setSaveHint("JSON에서 불러왔어요.");
      } catch {
        alert("불러오기에 실패했어요. JSON 형식을 확인하세요.");
      }
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }
  function copyStudentLink() {
    navigator.clipboard
      .writeText(studentLink)
      .then(() => setSaveHint("학생용 링크를 복사했어요."));
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 text-gray-900">
      {/* 상단 앱바 */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600 text-white grid place-items-center font-bold shadow">
              V
            </div>
            <div>
              {viewMode === "admin" ? (
                <input
                  className="text-xl md:text-2xl font-semibold bg-transparent border-b border-transparent focus:border-indigo-400 outline-none px-1 rounded"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-label="제목"
                />
              ) : (
                <div className="text-xl md:text-2xl font-semibold">{title}</div>
              )}
              <div className="text-xs text-gray-500">
                1·2표 / QR 학생화면 / 결과공개 제어 / 자동마감 / 저장
              </div>
            </div>
          </div>

          {viewMode === "admin" ? (
            <div className="flex items-center gap-2">
              <button
                onClick={saveJSON}
                className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow"
              >
                JSON 저장
              </button>
              <button
                onClick={saveCSV}
                className="px-3 py-2 rounded-xl bg-white border hover:bg-gray-50 shadow"
              >
                CSV 저장
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-2 rounded-xl bg-white border hover:bg-gray-50 shadow"
              >
                불러오기
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={loadFromFile}
              />
            </div>
          ) : (
            <div className="text-xs text-gray-500">학생 화면</div>
          )}
        </div>

        {/* 진행 현황 바 */}
        {viewMode === "admin" && (
          <div className="border-t bg-gradient-to-r from-indigo-50 to-purple-50">
            <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
              <span className="px-2 py-1 rounded-full bg-white border text-gray-700">
                투표 {votedCount}
                {expectedVoters > 0 ? `/${expectedVoters}` : ""}
              </span>
              {isClosed ? (
                <span className="px-2 py-1 rounded-full bg-rose-100 text-rose-700 border">
                  마감됨
                </span>
              ) : (
                <span className="px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 border">
                  진행중
                </span>
              )}
              <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500"
                  style={{
                    width: `${
                      expectedVoters
                        ? Math.min(100, (votedCount / expectedVoters) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </header>

      {viewMode === "admin" ? (
        <AdminView
          {...{
            desc,
            setDesc,
            voteLimit,
            setVoteLimit,
            options,
            ballots,
            anonymous,
            setAnonymous,
            visibilityMode,
            setVisibilityMode,
            deadlineAt,
            setDeadlineAt,
            totalVotes,
            graphData,
            isVisible,
            addOption,
            setOptionLabel,
            removeOption,
            clearAll,
            recountVotes,
            removeVoter: (id: string) => {
              const info = ballots[id];
              if (!info) return;
              if (!confirm(`${id}의 투표를 삭제할까요?`)) return;
              setOptions((prev) =>
                prev.map((o) => ({
                  ...o,
                  votes: o.votes - (info.ids.includes(o.id) ? 1 : 0),
                }))
              );
              setBallots((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            },
            saveHint,
            studentLink,
            copyStudentLink,
            expectedVoters,
            setExpectedVoters,
            isClosed,
            closeNow,
            reopen,
          }}
        />
      ) : (
        <StudentView
          {...{
            desc,
            options,
            voteLimit,
            anonymous,
            visibilityMode,
            deadlineAt,
            isVisible,
            voterName,
            setVoterName,
            selected,
            setSelected,
            toggleSelect,
            submitVote,
            totalVotes,
            graphData,
            isClosed,
          }}
        />
      )}

      <footer className="max-w-6xl mx-auto px-4 pb-10 text-xs text-gray-400">
        Made for classroom by 교무 · 데이터는 이 기기(localStorage)에만 저장됩니다.
      </footer>
    </div>
  );
}

// ===================== 관리자 화면 =====================
function AdminView(props: any) {
  const {
    desc,
    setDesc,
    voteLimit,
    setVoteLimit,
    options,
    ballots,
    anonymous,
    setAnonymous,
    visibilityMode,
    setVisibilityMode,
    deadlineAt,
    setDeadlineAt,
    totalVotes,
    graphData,
    isVisible,
    addOption,
    setOptionLabel,
    removeOption,
    clearAll,
    recountVotes,
    removeVoter,
    saveHint,
    studentLink,
    copyStudentLink,
    expectedVoters,
    setExpectedVoters,
    isClosed,
    closeNow,
    reopen,
  } = props;

  const votedCount = Object.keys(ballots).length;

  return (
    <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-5 gap-6">
      {/* 왼쪽: 설정 & 투표 관리 */}
      <section className="lg:col-span-2 space-y-6">
        {/* 설명 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <label className="text-sm text-gray-500">설명</label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full mt-2 p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-300"
            rows={3}
            placeholder="투표 목적/안내를 적어주세요."
          />

          <div className="mt-4 grid grid-cols-1 gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 방식</span>
                <select
                  value={voteLimit}
                  onChange={(e) => setVoteLimit(Number(e.target.value))}
                  className="border rounded-lg px-2 py-1"
                >
                  <option value={1}>1인 1표</option>
                  <option value={2}>1인 2표</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-500">익명 모드</label>
                <input
                  type="checkbox"
                  className="scale-110"
                  checked={anonymous}
                  onChange={(e) => setAnonymous(e.target.checked)}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">결과 공개</span>
                <select
                  value={visibilityMode}
                  onChange={(e) => setVisibilityMode(e.target.value)}
                  className="border rounded-lg px-2 py-1"
                >
                  <option value="always">항상 공개</option>
                  <option value="hidden">항상 숨김</option>
                  <option value="deadline">마감 후 공개</option>
                </select>
                {visibilityMode === "deadline" && (
                  <input
                    type="datetime-local"
                    className="border rounded-lg px-2 py-1"
                    value={deadlineAt ? new Date(deadlineAt).toISOString().slice(0, 16) : ""}
                    onChange={(e) =>
                      setDeadlineAt(
                        e.target.value ? new Date(e.target.value).getTime() : null
                      )
                    }
                  />
                )}
              </div>
            </div>

            {/* 투표 인원 설정 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 인원</span>
                <input
                  type="number"
                  min={0}
                  className="w-24 border rounded-lg px-2 py-1"
                  value={expectedVoters}
                  onChange={(e) =>
                    setExpectedVoters(Math.max(0, Number(e.target.value || 0)))
                  }
                />
                <span className="text-xs text-gray-500">0이면 자동 마감 없음</span>
              </div>
              <div className="flex items-center gap-2">
                {!isClosed ? (
                  <button
                    onClick={closeNow}
                    className="px-3 py-1.5 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 shadow"
                  >
                    지금 마감
                  </button>
                ) : (
                  <button
                    onClick={reopen}
                    className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow"
                  >
                    재개
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-sm text-gray-500">
              <div>
                참여: <span className="font-semibold">{votedCount}</span>
                {expectedVoters ? ` / ${expectedVoters}` : ""} · 총 표수:{" "}
                <span className="font-semibold">{totalVotes}</span>
              </div>
              <div>{saveHint}</div>
            </div>
          </div>
        </div>

        {/* 보기(옵션) — 위로 이동 완료 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">보기(옵션)</h2>
            <button
              onClick={addOption}
              className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            >
              추가
            </button>
          </div>
          <ul className="mt-3 space-y-2">
            {options.map((o: any) => (
              <li key={o.id} className="flex items-center gap-2">
                <input
                  className="flex-1 border rounded-lg px-2 py-1"
                  value={o.label}
                  onChange={(e) => setOptionLabel(o.id, e.target.value)}
                />
                <span className="text-xs text-gray-500 w-14 text-right">{o.votes} 표</span>
                <button
                  onClick={() => removeOption(o.id)}
                  className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50"
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
            <button
              onClick={clearAll}
              className="px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50"
            >
              전체 초기화
            </button>
            <button
              onClick={recountVotes}
              className="px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50"
            >
              표 재계산
            </button>
          </div>
        </div>

        {/* 학생용 링크 & QR — 아래로 이동 완료 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">학생용 화면 링크</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={copyStudentLink}
                className="px-3 py-1.5 text-sm rounded-lg bg-white border hover:bg-gray-50"
              >
                링크 복사
              </button>
              <a
                href="#student"
                className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
              >
                바로 열기
              </a>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
            <div className="flex items-center justify-center p-3 bg-gray-50 rounded-xl border">
              <QRCode value={studentLink} size={160} />
            </div>
            <div className="text-sm text-gray-600 break-all leading-relaxed">
              {studentLink}
              <p className="mt-2 text-xs text-gray-500">
                QR을 화면에 띄우거나 링크를 메시지/알림장으로 공유하세요.
              </p>
            </div>
          </div>
        </div>

        {/* 투표자 목록 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">투표자 목록</h2>
          </div>
          {Object.keys(ballots).length === 0 ? (
            <p className="text-sm text-gray-500 mt-2">아직 투표가 없습니다.</p>
          ) : (
            <ul className="mt-2 max-h-48 overflow-auto divide-y">
              {Object.entries(ballots).map(([id, info]: any) => (
                <li key={id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <div className="font-medium">{info?.name || id}</div>
                    <div className="text-xs text-gray-500">
                      {new Date(info.at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-gray-500">
                      {info.ids
                        .map((x: string) => options.find((o: any) => o.id === x)?.label)
                        .filter(Boolean)
                        .join(", ")}
                    </div>
                    <button
                      onClick={() => removeVoter(id)}
                      className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50"
                    >
                      삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* 오른쪽: 실시간 결과 그래프 */}
      <section className="lg:col-span-3 space-y-6">
        <div className="bg-white rounded-2xl shadow p-4 h-[460px]">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">실시간 결과</h2>
            <div className="text-sm text-gray-500">
              참여 {votedCount}
              {expectedVoters ? `/${expectedVoters}` : ""} · 총 {totalVotes}표
            </div>
          </div>
          <div className="w-full h-[400px]">
            {isVisible ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={graphData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} />
                  <Tooltip formatter={(v: any) => `${v} 표`} />
                  <Bar dataKey="votes">
                    <LabelList dataKey="votes" position="top" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full grid place-items-center text-gray-400">
                결과 비공개 상태입니다.
              </div>
            )}
          </div>

          {isClosed && (
            <div className="mt-3 p-3 rounded-xl bg-rose-50 text-rose-700 text-sm border border-rose-100">
              투표가 마감되었습니다. 재개하려면 "재개" 버튼을 누르세요.
            </div>
          )}
        </div>

        <div className="bg-indigo-50 rounded-2xl border border-indigo-100 p-4">
          <h3 className="font-semibold">진행 팁</h3>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>투표 인원을 미리 설정하면 자동으로 마감돼요. (0 = 자동마감 없음)</li>
            <li>필요 시 언제든지 "지금 마감"/"재개" 버튼으로 제어하세요.</li>
            <li>익명 모드에선 기기당 1회, 실명 모드에선 이름/번호로 중복 투표가 막혀요.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}

// ===================== 학생 화면 =====================
function StudentView(props: any) {
  const {
    desc,
    options,
    voteLimit,
    anonymous,
    visibilityMode,
    deadlineAt,
    isVisible,
    voterName,
    setVoterName,
    selected,
    setSelected,
    toggleSelect,
    submitVote,
    totalVotes,
    graphData,
    isClosed,
  } = props;

  const [submitted, setSubmitted] = useState(false);

  function onSubmit() {
    submitVote();
    setSubmitted(true);
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="bg-white rounded-2xl shadow p-4">
        <div className="text-sm text-gray-500">안내</div>
        <div className="mt-1 whitespace-pre-wrap">{desc}</div>
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        {isClosed && (
          <div className="mb-3 p-3 rounded-xl bg-rose-50 text-rose-700 text-sm border border-rose-100">
            투표가 마감되어 더 이상 제출할 수 없습니다.
          </div>
        )}

        {!anonymous && (
          <div className="mb-3">
            <label className="text-sm text-gray-500">이름/번호</label>
            <input
              value={voterName}
              onChange={(e: any) => setVoterName(e.target.value)}
              placeholder="이름 또는 번호"
              className="mt-1 w-full border rounded-lg px-3 py-2"
              disabled={isClosed}
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {options.map((o: any) => {
            const checked = selected.includes(o.id);
            const disabled = isClosed || (!checked && selected.length >= voteLimit);
            return (
              <button
                key={o.id}
                onClick={() =>
                  setSelected((prev: string[]) => {
                    if (isClosed) return prev;
                    if (prev.includes(o.id)) return prev.filter((x: string) => x !== o.id);
                    if (prev.length >= voteLimit) return prev;
                    return [...prev, o.id];
                  })
                }
                className={`text-left p-3 rounded-xl border transition ${
                  checked ? "bg-indigo-50 border-indigo-300" : "bg-white hover:bg-gray-50"
                } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                disabled={disabled}
              >
                <div className="font-medium">{o.label}</div>
                <div className="text-xs text-gray-500">
                  {checked ? "선택됨" : `선택 가능 (${selected.length}/${voteLimit})`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <a href="#admin" className="text-xs text-gray-400 underline">
            관리자 화면
          </a>
          <button
            onClick={onSubmit}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isClosed}
          >
            제출
          </button>
        </div>

        {submitted && (
          <div className="mt-3 text-sm text-emerald-700">제출되었습니다. 감사합니다!</div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">결과</h2>
          <div className="text-sm text-gray-500">총 {totalVotes}표</div>
        </div>
        <div className="w-full h-[320px]">
          {isVisible ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={graphData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v: any) => `${v} 표`} />
                <Bar dataKey="votes">
                  <LabelList dataKey="votes" position="top" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full grid place-items-center text-gray-400">
              {visibilityMode === "deadline" && deadlineAt ? (
                <div className="text-center">
                  <div>결과는 발표 전 비공개입니다.</div>
                  <div className="text-xs mt-1">
                    공개 예정: {new Date(deadlineAt).toLocaleString()}
                  </div>
                </div>
              ) : (
                <div>결과 비공개 상태입니다.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
