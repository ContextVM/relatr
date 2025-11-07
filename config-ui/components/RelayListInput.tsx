import { useState } from "react";

interface RelayListInputProps {
  label: string;
  value: string[];
  onChange: (relays: string[]) => void;
  placeholder?: string;
  description?: string;
}

export function RelayListInput({
  label,
  value,
  onChange,
  placeholder = "wss://relay.example.com",
  description,
}: RelayListInputProps) {
  const [newRelay, setNewRelay] = useState("");

  const handleAdd = () => {
    const trimmed = newRelay.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
      setNewRelay("");
    }
  };

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="relay-list-input">
      <label>
        <span className="label-text">{label}</span>
        {description && (
          <span className="label-description">{description}</span>
        )}
      </label>
      <div className="relay-list-container">
        {value.length > 0 && (
          <ul className="relay-list">
            {value.map((relay, index) => (
              <li key={index} className="relay-item">
                <span className="relay-url">{relay}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(index)}
                  className="remove-button"
                  aria-label={`Remove ${relay}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="relay-add">
          <input
            type="text"
            value={newRelay}
            onChange={(e) => setNewRelay(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            className="relay-input"
          />
          <button
            type="button"
            onClick={handleAdd}
            className="add-button"
            disabled={!newRelay.trim()}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
