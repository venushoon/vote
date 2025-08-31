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

/** ===== 타입 ===== */
type Option = { id: string; label: string; votes: number };
type BallotInfo = { ids: string[]; at: number; name?: string };
type Ballots = Record<string, BallotInfo>;
type ViewMode = "admin" | "student";
type VisibilityMode = "always" | "hidden" | "deadline";

/** ===== 유틸 ===== */
function uuid() {
  return (
    (window.crypto?.randomUUID?.() as string) ||
    `id-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

function getViewMode(): ViewMode {
  return location.hash === "#student" ? "student" : "admin";
}

/** ===== 메인 앱 ===== */
export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>(getViewMode());
  useEffect(() => {
    const onHash = () => setViewMode(getViewMode());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 공통 상태
  const [title, setTitle] = useState("우리 반 결정 투표");
  const [desc, setDesc] = useState("설명을 입력하세요. 예) 체험학습 장소를 골라요!");
  const [voteLimit, setVoteLimit] = useState<1 | 2>(1);
  const [options, setOptions] = useState<Option[]>([
    { id: uuid(), label: "보기 1", votes: 0 },
    { id: uuid(), label: "보기 2", votes: 0 },
  ]);
  const [ballots, setBallots] = useState<Ballots>({});
  const [anonymous, setAnonymous] = useState(false);
  const [visibilityMode, setVisibilityMode] = useState<VisibilityMode>("always");
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);

  // 학생 측 입력
  const [voterName, setVoterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  // 저장 힌트
  const [saveHint, setSaveHint] = useState("");

  // 로컬스토리지
  const STORAGE_KEY = "classroom_vote_v2";
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
    } catch (e) {
      console.warn("로컬 데이터 불러오기 실패", e);
    }
  }, []);
  useEffect(() => {
    const payload = JSON.stringify({
      title,
      desc,
      voteLimit,
      options,
      ballots,
      anonymous,
      visibilityMode,
      deadlineAt,
    });
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
  ]);

  // 계산값
  const totalVotes = useMemo(
    () => options.reduce((a, b) => a + b.votes, 0),
    [options]
  );
  const graphData = useMemo(
    () => options.map((o) => ({ name: o.label, votes: o.votes })),
    [options]
  );

  // 공개 여부
  const now = Date.now();
  const isVisible = useMemo(() => {
    if (viewMode === "admin") return true; // 👈 관리자는 항상 보임
    if (visibilityMode === "always") return true;
    if (visibilityMode === "hidden") return false;
    if (!deadlineAt) return false; // 마감시간 미설정 시 숨김
    return now >= deadlineAt;
  }, [viewMode, visibilityMode, deadlineAt, now]);

  /** ===== 옵션 편집 ===== */
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
      const next: Ballots = {};
      Object.entries(prev).forEach(([k, info]) => {
        const filtered = info.ids.filter((x) => x !== id);
        next[k] = { ...info, ids: filtered };
      });
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
        ids.forEach(
          (id) => (countMap[id] = (countMap[id] || 0) + 1)
        )
      );
      return zeroed.map((o) => ({ ...o, votes: countMap[o.id] || 0 }));
    });
  }

  /** ===== 투표 제출 ===== */
  function getStudentKey() {
    if (anonymous) {
      let token = localStorage.getItem("vote_device_token");
      if (!token) {
        token = uuid();
        localStorage.setItem("vote_device_token", token);
      }
      return token;
    }
    const id = voterName.trim();
    return id;
  }
  function submitVote() {
    const key = getStudentKey();
    if (!key) return alert("이름/번호를 입력하세요.");
    if (selected.length === 0) return alert("선택한 보기가 없습니다.");
    if (ballots[key]) return alert("이미 투표했습니다.");

    const at = Date.now();
    setBallots((prev) => ({
      ...prev,
      [key]: {
        ids: selected,
        at,
        name: anonymous ? undefined : voterName.trim(),
      },
    }));
    setOptions((prev) =>
      prev.map((o) => ({
        ...o,
        votes: o.votes + (selected.includes(o.id) ? 1 : 0),
      }))
    );
    setVoterName("");
    setSelected([]);
  }

  /** ===== 관리자: 초기화/삭제 ===== */
function clearAll() {
  if (!confirm("모든 설정과 결과를 초기화할까요? (되돌릴 수 없음)")) return;

  // 기본 상태로 리셋
  setTitle("우리 반 결정 투표");
  setDesc("설명을 입력하세요. 예) 체험학습 장소를 골라요!");
  setVoteLimit(1);
  setOptions([
    { id: uuid(), label: "보기 1", votes: 0 },
    { id: uuid(), label: "보기 2", votes: 0 },
  ]);
  setBallots({});
  setAnonymous(false);
  setVisibilityMode("always");
  setDeadlineAt(null);
  setSelected([]);
  setSaveHint("전체 초기화 완료!");
}
  function removeVoter(id: string) {
    if (!confirm(`${id}의 투표를 삭제할까요?`)) return;
    const info = ballots[id];
    if (!info) return;
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
  }

  /** ===== 저장/불러오기 ===== */
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
        setSaveHint("JSON에서 불러왔어요.");
      } catch {
        alert("불러오기에 실패했어요. JSON 형식을 확인하세요.");
      }
    };
    reader.readAsText(file, "utf-8");
    e.target.value = ""; // 같은 파일 재선택 허용
  }

 // ====== 공유 링크/QR ======
const studentLink = useMemo(() => {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#student`;
}, [viewMode]);  // 해시/화면 모드 변경 시 재계산

function copyStudentLink() {
  navigator.clipboard
    .writeText(studentLink)
    .then(() => setSaveHint("학생용 링크를 복사했어요."));
}

  /** ===== 렌더 ===== */
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
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
                1인 1·2표 / QR 학생화면 / 결과공개 제어 / 저장
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
      </header>

      {viewMode === "admin" ? (
        <AdminView
          desc={desc}
          setDesc={setDesc}
          voteLimit={voteLimit}
          setVoteLimit={setVoteLimit}
          options={options}
          ballots={ballots}
          anonymous={anonymous}
          setAnonymous={setAnonymous}
          visibilityMode={visibilityMode}
          setVisibilityMode={setVisibilityMode}
          deadlineAt={deadlineAt}
          setDeadlineAt={setDeadlineAt}
          totalVotes={totalVotes}
          graphData={graphData}
          isVisible={isVisible}
          addOption={addOption}
          setOptionLabel={setOptionLabel}
          removeOption={removeOption}
          clearAll={clearAll}
          recountVotes={recountVotes}
          removeVoter={removeVoter}
          saveHint={saveHint}
          studentLink={studentLink}
          copyStudentLink={copyStudentLink}
        />
      ) : (
        <StudentView
          title={title}
          desc={desc}
          options={options}
          voteLimit={voteLimit}
          anonymous={anonymous}
          visibilityMode={visibilityMode}
          deadlineAt={deadlineAt}
          isVisible={isVisible}
          voterName={voterName}
          setVoterName={setVoterName}
          selected={selected}
          setSelected={setSelected}
          toggleSelect={toggleSelect}
          submitVote={submitVote}
          totalVotes={totalVotes}
          graphData={graphData}
        />
      )}

      <footer className="max-w-6xl mx-auto px-4 pb-10 text-xs text-gray-400">
        Made for classroom by 교무 · 데이터는 이 기기(localStorage)에만 저장됩니다.
      </footer>
    </div>
  );
}

/** ==================== 관리자 화면 ==================== */
type AdminProps = {
  desc: string;
  setDesc: (v: string) => void;
  voteLimit: 1 | 2;
  setVoteLimit: (v: 1 | 2) => void;
  options: Option[];
  ballots: Ballots;
  anonymous: boolean;
  setAnonymous: (b: boolean) => void;
  visibilityMode: VisibilityMode;
  setVisibilityMode: (v: VisibilityMode) => void;
  deadlineAt: number | null;
  setDeadlineAt: (v: number | null) => void;
  totalVotes: number;
  graphData: { name: string; votes: number }[];
  isVisible: boolean;
  addOption: () => void;
  setOptionLabel: (id: string, label: string) => void;
  removeOption: (id: string) => void;
  clearAll: () => void;
  recountVotes: () => void;
  removeVoter: (id: string) => void;
  saveHint: string;
  studentLink: string;
  copyStudentLink: () => void;
};

function AdminView({
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
}: AdminProps) {
  return (
    <main className="max-w-6xl mx-auto px-4 py-6 grid md:grid-cols-5 gap-6">
      {/* 왼쪽: 설정 & 투표 관리 */}
      <section className="md:col-span-2 space-y-6">
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
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 방식</span>
                <select
                  value={voteLimit}
                  onChange={(e) => setVoteLimit(Number(e.target.value) as 1 | 2)}
                  className="border rounded-lg px-2 py-1"
                >
                  <option value={1}>1인 1표</option>
                  <option value={2}>1인 2표</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-500">
                익명 모드
                <input
                  type="checkbox"
                  checked={anonymous}
                  onChange={(e) => setAnonymous(e.target.checked)}
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">결과 공개</span>
                <select
                  value={visibilityMode}
                  onChange={(e) =>
                    setVisibilityMode(e.target.value as VisibilityMode)
                  }
                  className="border rounded-lg px-2 py-1"
                >
                  <option value="always">항상 공개</option>
                  <option value="hidden">항상 숨김</option>
                  <option value="deadline">마감 후 공개</option>
                </select>
              </div>
              {visibilityMode === "deadline" && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500">마감 시각</span>
                  <input
                    type="datetime-local"
                    className="border rounded-lg px-2 py-1"
                    value={
                      deadlineAt ? new Date(deadlineAt).toISOString().slice(0, 16) : ""
                    }
                    onChange={(e) =>
                      setDeadlineAt(
                        e.target.value ? new Date(e.target.value).getTime() : null
                      )
                    }
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-sm text-gray-500">
              <div>
                총 투표수: <span className="font-semibold">{totalVotes}</span>
              </div>
              <div>{saveHint}</div>
            </div>
          </div>
        </div>

        {/* 학생용 링크 & QR */}
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

        {/* 옵션 편집 */}
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
            {options.map((o) => (
              <li key={o.id} className="flex items-center gap-2">
                <input
                  className="flex-1 border rounded-lg px-2 py-1"
                  value={o.label}
                  onChange={(e) => setOptionLabel(o.id, e.target.value)}
                />
                <span className="text-xs text-gray-500 w-14 text-right">
                  {o.votes} 표
                </span>
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

        {/* 투표자 목록 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">투표자 목록</h2>
          </div>
          {Object.keys(ballots).length === 0 ? (
            <p className="text-sm text-gray-500 mt-2">아직 투표가 없습니다.</p>
          ) : (
            <ul className="mt-2 max-h-48 overflow-auto divide-y">
              {Object.entries(ballots).map(([id, info]) => (
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
                        .map((x) => options.find((o) => o.id === x)?.label)
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
      <section className="md:col-span-3 space-y-6">
        <div className="bg-white rounded-2xl shadow p-4 h-[420px]">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">실시간 결과</h2>
            <div className="text-sm text-gray-500">총 {totalVotes}표</div>
          </div>
          <div className="w-full h-[360px]">
            {isVisible ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={graphData}
                  margin={{ top: 20, right: 20, bottom: 20, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} />
                  <Tooltip formatter={(v: unknown) => `${v as number} 표`} />
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
        </div>

        {/* 진행 안내 */}
        <div className="bg-indigo-50 rounded-2xl border border-indigo-100 p-4">
          <h3 className="font-semibold">진행 팁</h3>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>우상단 메뉴로 저장/불러오기 가능합니다(JSON/CSV).</li>
            <li>
              "결과 공개"를 <b>마감 후 공개</b>로 두고 마감 시각을 설정하면, 발표 전 비공개·마감 후 자동 공개가 됩니다.
            </li>
            <li>익명 모드에선 학생 이름 입력 없이 디바이스당 1회 투표로 제한됩니다.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}

/** ==================== 학생 화면 ==================== */
type StudentProps = {
  title: string;
  desc: string;
  options: Option[];
  voteLimit: 1 | 2;
  anonymous: boolean;
  visibilityMode: VisibilityMode;
  deadlineAt: number | null;
  isVisible: boolean;
  voterName: string;
  setVoterName: (v: string) => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  submitVote: () => void;
  totalVotes: number;
  graphData: { name: string; votes: number }[];
};

function StudentView({
  title,
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
  submitVote,
  totalVotes,
  graphData,
}: StudentProps) {
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
        {!anonymous && (
          <div className="mb-3">
            <label className="text-sm text-gray-500">이름/번호</label>
            <input
              value={voterName}
              onChange={(e) => setVoterName(e.target.value)}
              placeholder="이름 또는 번호"
              className="mt-1 w-full border rounded-lg px-3 py-2"
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {options.map((o) => {
            const checked = selected.includes(o.id);
            const disabled = !checked && selected.length >= voteLimit;
            return (
              <button
                key={o.id}
                onClick={() =>
                  setSelected(
                    checked
                      ? selected.filter((x) => x !== o.id)
                      : selected.length >= voteLimit
                      ? selected
                      : [...selected, o.id]
                  )
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
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
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
              <BarChart
                data={graphData}
                margin={{ top: 20, right: 20, bottom: 20, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v: unknown) => `${v as number} 표`} />
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
