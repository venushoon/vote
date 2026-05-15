import React, { useState, useMemo } from 'react';
import { StudentViewProps } from '../types';

export const StudentView: React.FC<StudentViewProps> = ({ poll, submitVote, now }) => {
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // 실시간 now 기반 마감 체크 (UX 힌트 용도)
  const isClosed = useMemo(() => {
    if (poll.manualClosed) return true;
    if (poll.expectedVoters > 0 && Object.keys(poll.ballots || {}).length >= poll.expectedVoters) return true;
    return false;
  }, [poll]);

  const baseVisible = useMemo(() => {
    if (poll.visibilityMode === 'always') return true;
    if (poll.visibilityMode === 'closed' && isClosed) return true;
    if (poll.visibilityMode === 'deadline') return now >= poll.deadlineAt;
    return false;
  }, [poll.visibilityMode, isClosed, now, poll.deadlineAt]);

  const onSubmit = async () => {
    if (!selectedOption) return;
    if (isClosed) {
      alert("마감된 투표입니다.");
      return;
    }

    setIsSubmitting(true);
    // 4. 제출 성공 여부에 따라 UI 상태 업데이트
    const res = await submitVote(selectedOption);
    if (res.committed) {
      setSubmitted(true);
    } else {
      alert(res.error || "제출에 실패했습니다.");
    }
    setIsSubmitting(false);
  };

  return (
    <div className="p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-4">설문조사</h1>
      {submitted ? (
        <div className="bg-green-100 text-green-800 p-4 rounded text-center">
          투표가 성공적으로 제출되었습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {poll.options.map(opt => (
            <label key={opt.id} className="flex items-center gap-2 p-3 border rounded cursor-pointer hover:bg-gray-50">
              <input 
                type="radio" 
                name="vote" 
                value={opt.id}
                onChange={() => setSelectedOption(opt.id)}
                disabled={isClosed || isSubmitting}
              />
              <span>{opt.label}</span>
            </label>
          ))}
          <button 
            onClick={onSubmit} 
            disabled={!selectedOption || isClosed || isSubmitting}
            className="mt-4 bg-blue-500 text-white p-3 rounded disabled:opacity-50"
          >
            {isSubmitting ? '제출 중...' : '투표하기'}
          </button>
        </div>
      )}
      {baseVisible && (
        <div className="mt-8 p-4 bg-gray-100 rounded">
          <h2 className="font-bold mb-2">현재 결과</h2>
          <p>총 투표 수: {Object.keys(poll.ballots || {}).length}</p>
        </div>
      )}
    </div>
  );
};
