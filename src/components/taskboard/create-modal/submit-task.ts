import type { Dispatch, SetStateAction } from "react";
import type { Project, TaskType } from "../../../types";
import { checkProjectPath, createProject, getProjects, isApiRequestError } from "../../../api";
import type { FormFeedback, Locale, MissingPathPrompt, TFunction } from "../constants";

type CreateTaskHandler = (input: {
  title: string;
  description?: string;
  department_id?: string;
  task_type?: string;
  priority?: number;
  project_id?: string;
  project_path?: string;
  assigned_agent_id?: string;
}) => void | Promise<void>;

type ResolvePathHelperErrorMessage = (error: unknown, fallback: Record<Locale, string>) => string;

type SubmitTaskOptions = {
  allowCreateMissingPath?: boolean;
  allowWithoutProject?: boolean;
};

interface SubmitTaskContext {
  title: string;
  description: string;
  departmentId: string;
  taskType: TaskType;
  priority: number;
  assignAgentId: string;
  projectId: string;
  projectQuery: string;
  createNewProjectMode: boolean;
  newProjectPath: string;
  selectedProject: Project | null;
  projects: Project[];
  submitBusy: boolean;
  t: TFunction;
  unsupportedPathApiMessage: string;
  resolvePathHelperErrorMessage: ResolvePathHelperErrorMessage;
  onCreate: CreateTaskHandler;
  onClose: () => void;
  selectProject: (project: Project | null) => void;
  setFormFeedback: (feedback: FormFeedback | null) => void;
  setSubmitWithoutProjectPromptOpen: (open: boolean) => void;
  setSubmitBusy: (busy: boolean) => void;
  setProjectId: (projectId: string) => void;
  setProjectQuery: (query: string) => void;
  setCreateNewProjectMode: (enabled: boolean) => void;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setMissingPathPrompt: (prompt: MissingPathPrompt | null) => void;
  setNewProjectPath: (path: string) => void;
  setPathApiUnsupported: (unsupported: boolean) => void;
  setProjectDropdownOpen: (open: boolean) => void;
}

export async function submitTaskWithProjectHandling(
  context: SubmitTaskContext,
  options: SubmitTaskOptions = {},
): Promise<void> {
  const allowCreateMissingPath = options.allowCreateMissingPath ?? false;
  const allowWithoutProject = options.allowWithoutProject ?? false;
  const {
    title,
    description,
    departmentId,
    taskType,
    priority,
    assignAgentId,
    projectId,
    projectQuery,
    createNewProjectMode,
    newProjectPath,
    selectedProject,
    projects,
    submitBusy,
    t,
    unsupportedPathApiMessage,
    resolvePathHelperErrorMessage,
    onCreate,
    onClose,
    selectProject,
    setFormFeedback,
    setSubmitWithoutProjectPromptOpen,
    setSubmitBusy,
    setProjectId,
    setProjectQuery,
    setCreateNewProjectMode,
    setProjects,
    setMissingPathPrompt,
    setNewProjectPath,
    setPathApiUnsupported,
    setProjectDropdownOpen,
  } = context;

  if (!title.trim()) return;
  if (submitBusy) return;
  setFormFeedback(null);
  setSubmitWithoutProjectPromptOpen(false);

  let resolvedProject = selectedProject;

  if (!resolvedProject && projectQuery.trim()) {
    const query = projectQuery.trim().toLowerCase();
    const exact = projects.find(
      (project) => project.name.toLowerCase() === query || project.project_path.toLowerCase() === query,
    );
    if (exact) {
      resolvedProject = exact;
    } else {
      const prefixMatches = projects.filter(
        (project) =>
          project.name.toLowerCase().startsWith(query) || project.project_path.toLowerCase().startsWith(query),
      );
      if (prefixMatches.length === 1) {
        resolvedProject = prefixMatches[0];
      }
    }
  }

  if (projectId && !resolvedProject) {
    setFormFeedback({
      tone: "error",
      message: t({
        en: "The selected project was not found. Please select again.",
      }),
    });
    return;
  }

  if (!resolvedProject && projectQuery.trim() && !createNewProjectMode) {
    setFormFeedback({
      tone: "error",
      message: t({
        en: "Could not resolve the typed project. Pick from the list or clear it to continue.",
      }),
    });
    setProjectDropdownOpen(true);
    return;
  }

  if (!resolvedProject && createNewProjectMode) {
    const projectName = projectQuery.trim();
    const coreGoal = description.trim();
    if (!projectName) {
      setFormFeedback({
        tone: "error",
        message: t({
          en: "Please enter a new project name.",
        }),
      });
      return;
    }
    if (!newProjectPath.trim()) {
      setFormFeedback({
        tone: "error",
        message: t({
          en: "Please enter a new project path.",
        }),
      });
      return;
    }
    if (!coreGoal) {
      setFormFeedback({
        tone: "error",
        message: t({
          en: "Description is required for new project creation and will be saved as the project core goal.",
        }),
      });
      return;
    }

    setSubmitBusy(true);
    try {
      const rawNewProjectPath = newProjectPath.trim();
      let normalizedPath = rawNewProjectPath;
      let createPathIfMissing = true;

      try {
        const pathCheck = await checkProjectPath(rawNewProjectPath);
        normalizedPath = pathCheck.normalized_path || rawNewProjectPath;
        if (normalizedPath !== rawNewProjectPath) {
          setNewProjectPath(normalizedPath);
        }

        if (pathCheck.exists && !pathCheck.is_directory) {
          setFormFeedback({
            tone: "error",
            message: t({
              en: "The path is not a directory. Please enter a directory path.",
            }),
          });
          return;
        }

        if (!pathCheck.exists && !allowCreateMissingPath) {
          setMissingPathPrompt({
            normalizedPath,
            canCreate: pathCheck.can_create,
            nearestExistingParent: pathCheck.nearest_existing_parent,
          });
          return;
        }
        createPathIfMissing = !pathCheck.exists && allowCreateMissingPath;
      } catch (pathCheckError) {
        if (isApiRequestError(pathCheckError) && pathCheckError.status === 404) {
          setPathApiUnsupported(true);
          setFormFeedback({ tone: "info", message: unsupportedPathApiMessage });
          createPathIfMissing = true;
        } else {
          setFormFeedback({
            tone: "error",
            message: resolvePathHelperErrorMessage(pathCheckError, {
              en: "Failed to verify project path.",
            }),
          });
          return;
        }
      }

      const createdProject = await createProject({
        name: projectName,
        project_path: normalizedPath,
        core_goal: coreGoal,
        create_path_if_missing: createPathIfMissing,
      });
      setMissingPathPrompt(null);
      resolvedProject = createdProject;
      setProjectId(createdProject.id);
      setProjectQuery(createdProject.name);
      setCreateNewProjectMode(false);
      setProjects((prev) => {
        if (prev.some((project) => project.id === createdProject.id)) return prev;
        return [createdProject, ...prev];
      });
    } catch (error) {
      console.error("Failed to create project during task creation:", error);
      if (isApiRequestError(error) && error.code === "project_path_conflict") {
        const details =
          (error.details as {
            existing_project_id?: unknown;
            existing_project_name?: unknown;
            existing_project_path?: unknown;
          } | null) ?? null;
        const existingProjectId = typeof details?.existing_project_id === "string" ? details.existing_project_id : "";
        const existingProjectName =
          typeof details?.existing_project_name === "string" ? details.existing_project_name : "";
        const existingProjectPath =
          typeof details?.existing_project_path === "string" ? details.existing_project_path : "";
        const existingProject = projects.find(
          (project) =>
            (existingProjectId && project.id === existingProjectId) ||
            (existingProjectPath && project.project_path === existingProjectPath),
        );
        if (existingProject) {
          selectProject(existingProject);
        } else {
          setCreateNewProjectMode(false);
          setProjectDropdownOpen(true);
          void getProjects({ page: 1, page_size: 50 })
            .then((response) => setProjects(response.projects))
            .catch((loadError) => {
              console.error("Failed to refresh projects after path conflict:", loadError);
            });
        }
        setFormFeedback({
          tone: "info",
          message: t({
            en: existingProjectName
              ? `This path is already used by '${existingProjectName}'. Please use the existing project.`
              : "This path is already used by another project. Please use the existing project.",
          }),
        });
        return;
      }
      if (isApiRequestError(error) && error.code === "project_path_not_found") {
        const details =
          (error.details as {
            normalized_path?: unknown;
            can_create?: unknown;
            nearest_existing_parent?: unknown;
          } | null) ?? null;
        setMissingPathPrompt({
          normalizedPath:
            typeof details?.normalized_path === "string" ? details.normalized_path : newProjectPath.trim(),
          canCreate: Boolean(details?.can_create),
          nearestExistingParent:
            typeof details?.nearest_existing_parent === "string" ? details.nearest_existing_parent : null,
        });
        return;
      }
      setFormFeedback({
        tone: "error",
        message: resolvePathHelperErrorMessage(error, {
          en: "Failed to create a new project. Please check name/path.",
        }),
      });
      return;
    } finally {
      setSubmitBusy(false);
    }
  }

  if (!resolvedProject && !allowWithoutProject) {
    setSubmitWithoutProjectPromptOpen(true);
    return;
  }

  setSubmitBusy(true);
  try {
    await Promise.resolve(
      onCreate({
        title: title.trim(),
        description: description.trim() || undefined,
        department_id: departmentId || undefined,
        task_type: taskType,
        priority,
        project_id: resolvedProject?.id,
        project_path: resolvedProject?.project_path,
        assigned_agent_id: assignAgentId || undefined,
      }),
    );
    onClose();
  } catch (error) {
    console.error("Failed to create task:", error);
    setFormFeedback({
      tone: "error",
      message: t({
        en: "Failed to create task. Please try again shortly.",
      }),
    });
  } finally {
    setSubmitBusy(false);
  }
}
